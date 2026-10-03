import "server-only";
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { formatUsd, fromPayPalValue, type Cents } from "@/lib/money";
import { depositGateway, PayPalError } from "@/lib/paypal";
import type { RefundResult } from "@/lib/paypal/gateway";
import { appendEvent } from "./audit";
import { rentalById } from "./repo";
import { paypalStep } from "./service";
import { UserError, type Rental } from "./types";

type Query = Pick<Db, "query">;
type Row = Record<string, unknown>;

/**
 * Refunds of the money a settlement took: the final capture from the deposit
 * hold, and the charge above the deposit on the saved wallet. Staff refund
 * part or all of one capture, with a reason the renter sees on their page and
 * in PayPal's email.
 *
 * Each refund the counter starts gets the rental's next refund number, and
 * PayPal-Request-Id `refund:<rental id>:<number>`. The number is claimed in a
 * `refunds` row before PayPal is called and the counter page carries it in its
 * form, so a second submit of the same form (a double click, a retry after a
 * lost reply) reuses that request id and PayPal answers with the first refund,
 * while a later refund gets the next number and a new id.
 */

export type RefundState = "requested" | "done" | "refused";

export type StoredRefund = {
  id: string;
  rentalId: string;
  /** The counter's refund number; null for a refund only PayPal's webhook told us about. */
  seq: number | null;
  captureId: string;
  amountCents: Cents;
  reason: string | null;
  state: RefundState;
  refundId: string | null;
  paypalStatus: string | null;
  source: "counter" | "webhook";
  createdAt: string;
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function toRefund(r: Row): StoredRefund {
  return {
    id: String(r.id),
    rentalId: String(r.rental_id),
    seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
    captureId: String(r.capture_id),
    amountCents: Number(r.amount_cents),
    reason: (r.reason as string | null) ?? null,
    state: r.state as RefundState,
    refundId: (r.refund_id as string | null) ?? null,
    paypalStatus: (r.paypal_status as string | null) ?? null,
    source: r.source as StoredRefund["source"],
    createdAt: iso(r.created_at),
  };
}

export async function refundsFor(db: Query, rentalId: string): Promise<StoredRefund[]> {
  const rows = await db.query<Row>("select * from refunds where rental_id = $1 order by created_at, seq", [rentalId]);
  return rows.map(toRefund);
}

/** Money that went back to the renter, or is on its way: PayPal accepted the refund and has not reported it failed. */
export const isRefunded = (r: StoredRefund) => r.state === "done" && r.paypalStatus !== "FAILED" && r.paypalStatus !== "CANCELLED";

/** Counts against what is left to refund: refunded, or sent to PayPal with no answer recorded yet. */
const isSpoken = (r: StoredRefund) => isRefunded(r) || r.state === "requested";

export const refundedCents = (refunds: StoredRefund[]): Cents => refunds.filter(isRefunded).reduce((s, r) => s + r.amountCents, 0);

/** Refunded total per rental, for the counter's list. */
export async function refundTotals(db: Query): Promise<Map<string, Cents>> {
  const rows = await db.query<{ rental_id: string; cents: string | number }>(
    "select rental_id, sum(amount_cents) as cents from refunds where state = 'done' and coalesce(paypal_status, '') not in ('FAILED', 'CANCELLED') group by rental_id",
  );
  return new Map(rows.map((r) => [r.rental_id, Number(r.cents)]));
}

export type RefundableCapture = { captureId: string; label: string; capturedCents: Cents; refundedCents: Cents; leftCents: Cents };

/** The captures a settlement made, with what is left to refund on each. */
export function refundableCaptures(rental: Rental, refunds: StoredRefund[]): RefundableCapture[] {
  const captures = [
    { captureId: rental.settlementCaptureId, label: "the charge from the deposit", capturedCents: rental.capturedCents ?? 0 },
    { captureId: rental.extraCaptureId, label: "the charge above the deposit", capturedCents: rental.extraCents ?? 0 },
  ];
  return captures
    .filter((c): c is typeof c & { captureId: string } => Boolean(c.captureId) && c.capturedCents > 0)
    .map((c) => {
      const spoken = refunds.filter((r) => r.captureId === c.captureId && isSpoken(r)).reduce((s, r) => s + r.amountCents, 0);
      return { ...c, refundedCents: spoken, leftCents: Math.max(0, c.capturedCents - spoken) };
    });
}

/**
 * The refund number the counter's form carries. While a refund is waiting for
 * PayPal's answer (the reply was lost), it is that refund's number, so sending
 * it again asks PayPal about the same refund; otherwise the next one.
 */
export function nextRefundSeq(refunds: StoredRefund[]): number {
  const waiting = refunds.find((r) => r.source === "counter" && r.state === "requested");
  if (waiting?.seq) return waiting.seq;
  return Math.max(0, ...refunds.map((r) => r.seq ?? 0)) + 1;
}

export const refundRequestId = (rentalId: string, seq: number) => `refund:${rentalId}:${seq}`;

/** Whether PayPal definitely did not refund: a 4xx it would answer the same way again. Timeouts, conflicts and 5xx may have landed. */
const definitelyRefused = (err: PayPalError) => err.status >= 400 && err.status < 500 && ![408, 409, 429].includes(err.status);

export type RefundInput = { captureId: string; cents: number; reason: string; seq: number };

/**
 * Refunds part or all of one of the settlement's captures. Refused while a
 * PayPal dispute on the rental is open: money given back then belongs in the
 * dispute (an offer or an accepted claim), where PayPal counts it.
 */
export async function refundCharge(rentalId: string, input: RefundInput): Promise<StoredRefund> {
  const reason = String(input.reason ?? "").trim();
  if (!Number.isSafeInteger(input.cents) || input.cents <= 0) throw new UserError("Enter an amount above $0.00, in dollars and cents.");
  if (!reason) throw new UserError("Say briefly why you are refunding. The customer sees it on their page and in PayPal's email.");
  if (reason.length > 200) throw new UserError("Keep the reason under 200 characters.");
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new UserError("This page is out of date. Reload it and try again.");
  const db = await getDb();

  const claim = await db.tx(async (tx) => {
    // One refund decision at a time per rental: two submits of the same form are told apart here.
    const locked = await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    if (locked.length === 0) throw new UserError("That rental does not exist.");
    const rental = (await rentalById(tx, rentalId))!;
    const open = await tx.query("select id from disputes where rental_id = $1 and status <> 'RESOLVED' limit 1", [rentalId]);
    if (open.length > 0 || rental.status === "disputed") {
      throw new UserError(
        "The customer has an open PayPal dispute on this rental, so refund through the dispute desk on this page: offer part back or accept the claim. PayPal then counts the money toward the case.",
      );
    }
    if (rental.status !== "settled") throw new UserError("Only a settled rental can be refunded.");
    const refunds = await refundsFor(tx, rentalId);
    const capture = refundableCaptures(rental, refunds).find((c) => c.captureId === input.captureId);
    if (!capture) throw new UserError("Choose a charge this rental's settlement took: only those can be refunded here.");

    const same = refunds.find((r) => r.seq === input.seq);
    if (same) {
      if (same.captureId !== input.captureId || same.amountCents !== input.cents) {
        throw new UserError(
          same.state === "requested"
            ? `Refund ${same.seq} of ${formatUsd(same.amountCents)} is still waiting for PayPal's answer. Send that refund again, unchanged, so PayPal can say whether it went through.`
            : "This page is out of date: that refund number is taken. Reload it before refunding again.",
        );
      }
      if (same.state === "done") return { kind: "done" as const, refund: same };
      if (same.state === "refused") throw new UserError("PayPal refused this refund. Reload the page to try again.");
      return { kind: "send" as const, id: same.id };
    }
    if (input.seq !== nextRefundSeq(refunds)) throw new UserError("This page is out of date. Reload it before refunding again.");
    if (input.cents > capture.leftCents) {
      throw new UserError(
        capture.leftCents === 0
          ? `Everything taken for ${capture.label} has already been refunded.`
          : `At most ${formatUsd(capture.leftCents)} is left to refund on ${capture.label} (${formatUsd(capture.capturedCents)} taken, ${formatUsd(capture.refundedCents)} refunded).`,
      );
    }
    const id = randomUUID();
    await tx.query(
      "insert into refunds (id, rental_id, seq, capture_id, amount_cents, reason, state, source) values ($1, $2, $3, $4, $5, $6, 'requested', 'counter')",
      [id, rentalId, input.seq, input.captureId, input.cents, reason],
    );
    return { kind: "send" as const, id };
  });
  if (claim.kind === "done") return claim.refund;

  const requestId = refundRequestId(rentalId, input.seq);
  const seen: { refusal: PayPalError | null } = { refusal: null };
  let refund: RefundResult;
  try {
    refund = await paypalStep(rentalId, "refund a charge", async () => {
      try {
        return await depositGateway().refund(
          { captureId: input.captureId, amountCents: input.cents, noteToPayer: reason, invoiceId: `${rentalId}-refund-${input.seq}` },
          requestId,
        );
      } catch (err) {
        if (PayPalError.is(err)) seen.refusal = err;
        throw err;
      }
    });
  } catch (err) {
    // A definite refusal frees the number, so the next try gets a new request
    // id. Anything else may have landed: the row stays 'requested', and sending
    // the same refund again reuses the request id.
    if (seen.refusal && definitelyRefused(seen.refusal)) {
      await db.query("update refunds set state = 'refused', updated_at = now() where id = $1 and state = 'requested'", [claim.id]);
    }
    throw err;
  }

  const recorded = await db.tx(async (tx) => {
    await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    // PayPal's webhook may have reported this refund before PayPal's reply got here.
    await tx.query("delete from refunds where refund_id = $1 and seq is null", [refund.refundId]);
    const rows = await tx.query<Row>(
      "update refunds set state = 'done', refund_id = $2, paypal_status = $3, amount_cents = $4, updated_at = now() where id = $1 and state <> 'done' returning *",
      [claim.id, refund.refundId, refund.status, refund.amountCents],
    );
    if (rows.length > 0) {
      await appendEvent(tx, rentalId, "staff", "refund.issued", {
        refundId: refund.refundId,
        captureId: input.captureId,
        amountCents: refund.amountCents,
        status: refund.status,
        reason,
        refundNumber: input.seq,
        requestId,
      });
      return toRefund(rows[0]);
    }
    return toRefund((await tx.query<Row>("select * from refunds where id = $1", [claim.id]))[0]);
  });
  publish(rentalId, "refund.issued");
  return recorded;
}

// ─── PayPal's webhook ───────────────────────────────────────

/** The refund resource of a PAYMENT.CAPTURE.REFUNDED webhook (Payments v2 `refund`). */
export type RefundResource = {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  note_to_payer?: string;
  links?: { href?: string; rel?: string }[];
};

/** The refunded capture's id: the resource names it only in its `up` link, /v2/payments/captures/{id}. */
export function refundedCaptureId(resource: RefundResource): string | null {
  const up = resource.links?.find((l) => l.rel === "up")?.href ?? "";
  return /\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/.exec(up)?.[1] ?? null;
}

export async function rentalIdForRefund(db: Query, refundId: string): Promise<string | null> {
  const rows = await db.query<{ rental_id: string }>("select rental_id from refunds where refund_id = $1", [refundId]);
  return rows[0]?.rental_id ?? null;
}

/**
 * Applies a verified PAYMENT.CAPTURE.REFUNDED inside the webhook's
 * transaction. A refund the app already recorded is matched on PayPal's
 * refund id and counted once; only its status is updated. A refund made
 * elsewhere (PayPal's own dashboard, for example) is recorded without a refund
 * number. Returns the live event to publish, if anything changed.
 */
export async function recordRefundWebhook(tx: Query, rental: Rental, resource: RefundResource, webhookEventId: string): Promise<string | null> {
  if (!resource.id) return null;
  await tx.query("select id from rentals where id = $1 for update", [rental.id]);
  const known = await tx.query<Row>("select * from refunds where refund_id = $1", [resource.id]);
  if (known.length > 0) {
    const stored = toRefund(known[0]);
    if (resource.status && resource.status !== stored.paypalStatus) {
      await tx.query("update refunds set paypal_status = $2, updated_at = now() where id = $1", [stored.id, resource.status]);
      return "refund.updated";
    }
    return null;
  }
  const captureId = refundedCaptureId(resource);
  const ours = [rental.feeCaptureId, rental.settlementCaptureId, rental.extraCaptureId].filter(Boolean);
  if (!captureId || !ours.includes(captureId) || !resource.amount?.value || (resource.amount.currency_code ?? "USD") !== "USD") return null;
  const amountCents = fromPayPalValue(resource.amount.value);
  await tx.query(
    "insert into refunds (id, rental_id, seq, capture_id, amount_cents, reason, state, refund_id, paypal_status, source) values ($1, $2, null, $3, $4, $5, 'done', $6, $7, 'webhook')",
    [randomUUID(), rental.id, captureId, amountCents, resource.note_to_payer ?? null, resource.id, resource.status ?? null],
  );
  await appendEvent(tx, rental.id, "paypal", "refund.recorded", { refundId: resource.id, captureId, amountCents, status: resource.status ?? null, webhookEventId });
  return "refund.recorded";
}
