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
 * hold, and the charge above the deposit on the saved wallet; and, once a
 * paid booking is cancelled, of the rental fee (cancel.ts refunds the part
 * its policy or the counter decides, through the same claim and send). Staff
 * refund part or all of one capture, with a reason the renter sees on their
 * page and in PayPal's email.
 *
 * Each refund the counter starts gets the rental's next refund number, and
 * PayPal-Request-Id `refund:<rental id>:<number>` and invoice_id
 * `<rental id>-refund-<number>`. The number is claimed in a `refunds` row
 * before PayPal is called and the counter page carries it in its form, so a
 * second submit of the same form (a double click) reuses that request id and
 * PayPal answers with the first refund, while a later refund gets the next
 * number and a new id.
 *
 * When PayPal's answer is lost, the row stays 'requested' and its amount stays
 * reserved. The counter offers to send that refund again, unchanged, for an
 * hour (RESEND_WINDOW_MS): PayPal keeps request ids for a limited time, after
 * which a resend could refund twice. PayPal's PAYMENT.CAPTURE.REFUNDED names
 * the invoice id, which completes the row whenever it arrives.
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

/** Money refunded, on the given captures or on any. */
export const refundedCents = (refunds: StoredRefund[], captureIds?: (string | null)[]): Cents =>
  refunds.filter((r) => isRefunded(r) && (!captureIds || captureIds.includes(r.captureId))).reduce((s, r) => s + r.amountCents, 0);

/**
 * Refunded per rental of what the settlement took (the settlement capture and
 * the charge above the deposit), for the counter's list. A refund of the
 * booking fee is not part of what the shop kept from the deposit.
 */
export async function feeRefundTotals(db: Query): Promise<Map<string, Cents>> {
  const rows = await db.query<{ rental_id: string; cents: string | number }>(
    `select f.rental_id, sum(f.amount_cents) as cents from refunds f join rentals r on r.id = f.rental_id
     where f.state = 'done' and coalesce(f.paypal_status, '') not in ('FAILED', 'CANCELLED') and f.capture_id = r.fee_capture_id
     group by f.rental_id`,
  );
  return new Map(rows.map((r) => [r.rental_id, Number(r.cents)]));
}

/** Refunded per rental of what the settlement took; see feeRefundTotals for the fee. */
export async function refundTotals(db: Query): Promise<Map<string, Cents>> {
  const rows = await db.query<{ rental_id: string; cents: string | number }>(
    `select f.rental_id, sum(f.amount_cents) as cents from refunds f join rentals r on r.id = f.rental_id
     where f.state = 'done' and coalesce(f.paypal_status, '') not in ('FAILED', 'CANCELLED') and f.capture_id in (r.settlement_capture_id, r.extra_capture_id)
     group by f.rental_id`,
  );
  return new Map(rows.map((r) => [r.rental_id, Number(r.cents)]));
}

export type RefundableCapture = {
  captureId: string;
  label: string;
  capturedCents: Cents;
  /** Refunded, or sent to PayPal and not answered yet, outside any dispute. */
  refundedCents: Cents;
  /** Given back by PayPal through a dispute on this capture. */
  disputeCents: Cents;
  leftCents: Cents;
};

/** Money PayPal gave back through disputes, per disputed capture (disputes.refunded_cents). */
export async function disputeReturns(db: Query, rentalId: string): Promise<Map<string, Cents>> {
  const rows = await db.query<{ transaction_id: string; cents: string | number }>(
    "select transaction_id, sum(refunded_cents) as cents from disputes where rental_id = $1 and transaction_id is not null and refunded_cents > 0 group by transaction_id",
    [rentalId],
  );
  return new Map(rows.map((r) => [r.transaction_id, Number(r.cents)]));
}

/** True for a booking the renter or the counter cancelled after the fee was captured. */
export const cancelledAfterPayment = (rental: Rental) => rental.status === "cancelled" && rental.cancelledAt !== null && rental.feeCaptureId !== null;

type Capture = { captureId: string; label: string; capturedCents: Cents };

/** What is left to refund on one capture; see refundableCaptures. */
function leftOn(c: Capture, refunds: StoredRefund[], disputes: Map<string, Cents>): RefundableCapture {
  const on = refunds.filter((r) => r.captureId === c.captureId);
  const counter = on.filter((r) => r.seq !== null && isSpoken(r)).reduce((s, r) => s + r.amountCents, 0);
  const reported = on.filter((r) => r.seq === null && isRefunded(r)).reduce((s, r) => s + r.amountCents, 0);
  const dispute = disputes.get(c.captureId) ?? 0;
  const outside = Math.max(reported, dispute);
  // outside >= dispute, so refunded + dispute = everything that went back.
  return { ...c, refundedCents: counter + outside - dispute, disputeCents: dispute, leftCents: Math.max(0, c.capturedCents - counter - outside) };
}

/** The rental fee's capture with what is left to refund on it, or null before the fee was captured. */
export function feeCapture(rental: Rental, refunds: StoredRefund[], disputes: Map<string, Cents> = new Map()): RefundableCapture | null {
  if (!rental.feeCaptureId) return null;
  return leftOn({ captureId: rental.feeCaptureId, label: "the rental fee", capturedCents: rental.feeCents }, refunds, disputes);
}

/**
 * The captures a settlement made, or the fee capture of a booking cancelled
 * after payment, with what is left to refund on each:
 * what was captured, less the counter's refunds and the money that went back
 * outside the counter. That outside money is reported two ways, by
 * PAYMENT.CAPTURE.REFUNDED (rows without a refund number) and by a dispute's
 * outcome, and PayPal may report the same money both ways, so the larger of
 * the two counts. If they were in fact separate, this leaves too much, and
 * PayPal refuses the excess (REFUND_AMOUNT_EXCEEDED); it never counts the
 * same money twice.
 */
export function refundableCaptures(rental: Rental, refunds: StoredRefund[], disputes: Map<string, Cents> = new Map()): RefundableCapture[] {
  if (cancelledAfterPayment(rental)) return [feeCapture(rental, refunds, disputes)!];
  const captures = [
    { captureId: rental.settlementCaptureId, label: "the charge from the deposit", capturedCents: rental.capturedCents ?? 0 },
    { captureId: rental.extraCaptureId, label: "the charge above the deposit", capturedCents: rental.extraCents ?? 0 },
  ];
  return captures
    .filter((c): c is Capture => Boolean(c.captureId) && c.capturedCents > 0)
    .map((c) => leftOn(c, refunds, disputes));
}

/** The refund number the counter's form carries for a new refund. A refund waiting for PayPal's answer is sent again with its own number (resendRefund). */
export function nextRefundSeq(refunds: StoredRefund[]): number {
  return Math.max(0, ...refunds.map((r) => r.seq ?? 0)) + 1;
}

export const refundRequestId = (rentalId: string, seq: number) => `refund:${rentalId}:${seq}`;
export const refundInvoiceId = (rentalId: string, seq: number) => `${rentalId}-refund-${seq}`;

/**
 * How long after the first send a refund whose answer was lost may be sent
 * again with the same request id. Payments v2 does not say how long PayPal
 * keeps a PayPal-Request-Id; Orders v2 keeps them for 6 hours. One hour stays
 * well inside that.
 */
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

/** Counter refunds whose PayPal answer was lost, and whether they may still be sent again. */
export function waitingRefunds(refunds: StoredRefund[], now = Date.now()): (StoredRefund & { seq: number; resendable: boolean })[] {
  return refunds
    .filter((r): r is StoredRefund & { seq: number } => r.source === "counter" && r.state === "requested" && r.seq !== null)
    .map((r) => ({ ...r, resendable: now - Date.parse(r.createdAt) < RESEND_WINDOW_MS }));
}

export type RefundInput = { captureId: string; cents: number; reason: string; seq: number };

/**
 * Refunds part or all of one of the settlement's captures, or of the fee of a
 * booking cancelled after it was paid. Refused while a
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
    if (rental.status !== "settled" && !cancelledAfterPayment(rental)) throw new UserError("Only a settled rental, or a booking cancelled after it was paid, can be refunded.");
    const refunds = await refundsFor(tx, rentalId);
    const capture = refundableCaptures(rental, refunds, await disputeReturns(tx, rentalId)).find((c) => c.captureId === input.captureId);
    if (!capture) throw new UserError("Choose a charge this rental's settlement took, or the fee of a cancelled booking: only those can be refunded here.");

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
      if (Date.now() - Date.parse(same.createdAt) >= RESEND_WINDOW_MS) {
        throw new UserError(
          `Refund ${same.seq} was sent to PayPal more than an hour ago and its answer was lost. Sending it again now could refund twice, so check the capture in PayPal. When PayPal reports the refund, it is recorded here.`,
        );
      }
      return { kind: "send" as const, id: same.id };
    }
    if (input.seq !== nextRefundSeq(refunds)) throw new UserError("This page is out of date. Reload it before refunding again.");
    if (input.cents > capture.leftCents) {
      throw new UserError(
        capture.leftCents === 0
          ? `Everything taken for ${capture.label} has already been refunded.`
          : `At most ${formatUsd(capture.leftCents)} is left to refund on ${capture.label} (${formatUsd(capture.capturedCents)} taken, ${formatUsd(capture.refundedCents)} refunded${capture.disputeCents ? `, ${formatUsd(capture.disputeCents)} returned through the PayPal dispute` : ""}).`,
      );
    }
    return { kind: "send" as const, id: await claimRefund(tx, rentalId, { ...input, reason }) };
  });
  if (claim.kind === "done") return claim.refund;
  return sendRefund(rentalId, { id: claim.id, ...input, reason }, "staff");
}

/**
 * Claims refund number `seq` in a 'requested' row, inside the caller's
 * transaction and under its row lock, before PayPal is called. The amount
 * counts as refunded from here on, so nothing else can refund it twice.
 */
export async function claimRefund(tx: Query, rentalId: string, input: RefundInput): Promise<string> {
  const id = randomUUID();
  await tx.query(
    "insert into refunds (id, rental_id, seq, capture_id, amount_cents, reason, state, source) values ($1, $2, $3, $4, $5, $6, 'requested', 'counter')",
    [id, rentalId, input.seq, input.captureId, input.cents, input.reason],
  );
  return id;
}

/**
 * Sends a claimed refund to PayPal with PayPal-Request-Id refund:<rental>:<seq>
 * and invoice_id <rental>-refund-<seq>, and records PayPal's answer. A
 * definite refusal frees the number; anything else leaves the row
 * 'requested', to be sent again unchanged (resendRefund) or completed by
 * PayPal's webhook.
 */
export async function sendRefund(
  rentalId: string,
  input: RefundInput & { id: string },
  actor: "staff" | "customer",
  step = "refund a charge",
): Promise<StoredRefund> {
  const db = await getDb();
  const { reason } = input;
  const requestId = refundRequestId(rentalId, input.seq);
  const seen: { refusal: PayPalError | null } = { refusal: null };
  let refund: RefundResult;
  try {
    refund = await paypalStep(rentalId, step, async () => {
      try {
        return await depositGateway().refund(
          { captureId: input.captureId, amountCents: input.cents, noteToPayer: reason, invoiceId: refundInvoiceId(rentalId, input.seq) },
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
    if (seen.refusal?.definitelyRefused) {
      await db.query("update refunds set state = 'refused', updated_at = now() where id = $1 and state = 'requested'", [input.id]);
    }
    throw err;
  }

  const recorded = await db.tx(async (tx) => {
    await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    // PayPal's webhook may have reported this refund before PayPal's reply got here.
    await tx.query("delete from refunds where refund_id = $1 and seq is null", [refund.refundId]);
    const rows = await tx.query<Row>(
      "update refunds set state = 'done', refund_id = $2, paypal_status = $3, amount_cents = $4, updated_at = now() where id = $1 and state <> 'done' returning *",
      [input.id, refund.refundId, refund.status, refund.amountCents],
    );
    if (rows.length > 0) {
      await appendEvent(tx, rentalId, actor, "refund.issued", {
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
    return toRefund((await tx.query<Row>("select * from refunds where id = $1", [input.id]))[0]);
  });
  publish(rentalId, "refund.issued");
  return recorded;
}

/** Sends a refund whose PayPal answer was lost again, unchanged: same capture, amount, reason and request id. */
export async function resendRefund(rentalId: string, seq: number): Promise<StoredRefund> {
  const row = (await refundsFor(await getDb(), rentalId)).find((r) => r.seq === seq && r.source === "counter");
  if (!row) throw new UserError("That refund is not on this rental.");
  if (row.state !== "requested") return row;
  return refundCharge(rentalId, { captureId: row.captureId, cents: row.amountCents, reason: row.reason ?? "", seq });
}

// ─── PayPal's webhook ───────────────────────────────────────

/** The refund resource of a PAYMENT.CAPTURE.REFUNDED webhook (Payments v2 `refund`). */
export type RefundResource = {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  invoice_id?: string;
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
 * refund id and counted once; only its status is updated. A counter refund
 * whose answer was lost is matched on its invoice id and completed. A refund
 * made elsewhere (PayPal's own dashboard, for example) is recorded without a
 * refund number. Returns the live event to publish, if anything changed.
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

  const seq = new RegExp(`^${rental.id}-refund-(\\d+)$`).exec(resource.invoice_id ?? "")?.[1];
  const waiting = seq
    ? await tx.query<Row>("select * from refunds where rental_id = $1 and seq = $2 and source = 'counter' and state <> 'done'", [rental.id, Number(seq)])
    : [];
  if (waiting.length > 0) {
    const row = toRefund(waiting[0]);
    await tx.query("update refunds set state = 'done', refund_id = $2, paypal_status = $3, amount_cents = $4, updated_at = now() where id = $1", [
      row.id,
      resource.id,
      resource.status ?? null,
      amountCents,
    ]);
    await appendEvent(tx, rental.id, "staff", "refund.issued", {
      refundId: resource.id,
      captureId,
      amountCents,
      status: resource.status ?? null,
      reason: row.reason,
      refundNumber: row.seq,
      requestId: refundRequestId(rental.id, row.seq!),
      confirmedBy: "webhook",
      webhookEventId,
    });
    return "refund.issued";
  }
  await tx.query(
    "insert into refunds (id, rental_id, seq, capture_id, amount_cents, reason, state, refund_id, paypal_status, source) values ($1, $2, null, $3, $4, $5, 'done', $6, $7, 'webhook')",
    [randomUUID(), rental.id, captureId, amountCents, resource.note_to_payer ?? null, resource.id, resource.status ?? null],
  );
  await appendEvent(tx, rental.id, "paypal", "refund.recorded", { refundId: resource.id, captureId, amountCents, status: resource.status ?? null, webhookEventId });
  return "refund.recorded";
}
