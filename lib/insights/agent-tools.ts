import "server-only";
import { z } from "zod";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { disputesFor } from "@/lib/disputes/repo";
import { formatUsd } from "@/lib/money";
import { firstBrokenLink } from "@/lib/rentals/audit";
import { cancelledAfterPayment, disputeReturns, refundableCaptures, refundsFor, isRefunded } from "@/lib/rentals/refunds";
import { eventsFor, latestAssessment, rentalById, toRental } from "@/lib/rentals/repo";
import { isCharged } from "@/lib/rentals/settlement";
import { eventLabel, STATUS } from "@/lib/rentals/status";
import { findingOutcome, holdRow, originalHoldTime, renterFirstName, settlementMoney } from "./model";

/**
 * The deposit desk agent's own tools. The browser's agent calls them through
 * /api/insights/tools; each runs here, behind the staff check, on the
 * server's record. None of them changes anything:
 *
 *   holds_needing_attention  the running holds a person should look at
 *   explain_rental           one rental's money, findings, disputes and audit trail
 *   draft_refund             a refund proposal checked against the same limits as
 *                            the counter's refund; a person sends it from the
 *                            rental page. Nothing is written and PayPal is not called.
 *
 * Outputs carry no email, address or link token. The only text a renter
 * typed that reaches the model is their first name, cut down to letters,
 * apostrophes and hyphens (renterFirstName), because a name is free text
 * and the model reads it. Reasons and notes people typed into the audit
 * trail stay out; draft_refund echoes only the reason it was given.
 */

const RentalId = z.string().trim().regex(/^R-[A-Z0-9]{6}$/, "A rental id looks like R-7KQ2MX.");

export const TOOL_ARGS = {
  holds_needing_attention: z.object({ include_all: z.boolean().optional() }).strict(),
  explain_rental: z.object({ rental_id: RentalId }).strict(),
  draft_refund: z
    .object({
      rental_id: RentalId,
      amount_cents: z.number().int("Whole cents only.").positive("Above $0.00.").max(10_000_000),
      reason: z.string().trim().min(1, "Say why; the renter sees it.").max(200, "Keep the reason under 200 characters."),
      capture_id: z.string().trim().max(64).optional(),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof TOOL_ARGS;
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[];

export class ToolRefusal extends Error {}


// ─── holds_needing_attention ─────────────────────────────────

export async function holdsNeedingAttention(args: z.infer<(typeof TOOL_ARGS)["holds_needing_attention"]>, now = new Date()) {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "select * from rentals where status in ('out', 'inspecting', 'customer_review', 'responded') and authorization_id is not null order by authorization_expires_at nulls last",
  );
  const holds = rows.map((r) => holdRow(toRental(r), now)).filter((h) => h !== null);
  const pick = args.include_all ? holds : holds.filter((h) => h.needs_attention);
  return {
    as_of: now.toISOString(),
    running_holds: holds.length,
    held_total: formatUsd(holds.reduce((s, h) => s + h.amount_cents, 0)),
    needing_attention: holds.filter((h) => h.needs_attention).length,
    holds: pick.map((h) => ({
      rental_id: h.rental_id,
      item: h.item,
      renter: h.renter,
      held: formatUsd(h.amount_cents),
      state: h.state,
      held_at: h.held_at,
      renewal_due_at: h.renewal_due_at,
      renewed_at: h.renewed_at,
      expires_at: h.expires_at,
      days_left: h.days_left,
      due_back: h.due_back,
      attention: h.attention,
      paypal_authorization_id: h.authorization_id,
    })),
  };
}

// ─── explain_rental ──────────────────────────────────────────

/** Audit data keys that are ids and amounts, safe to show. Free text (reasons, notes, names) stays out. */
const SAFE_EVENT_KEYS = new Set([
  "orderId",
  "captureId",
  "authorizationId",
  "from",
  "refundId",
  "disputeId",
  "amountCents",
  "capturedCents",
  "releasedCents",
  "extraCents",
  "feeCents",
  "refundCents",
  "offerCents",
  "proposedCents",
  "maxHoldCents",
  "status",
  "outcome",
  "issue",
  "debugId",
  "requestId",
  "accepted",
  "contested",
  "source",
  "model",
  "policyPercent",
  "by",
  "paid",
  "sha256",
  "expiresAt",
]);

export async function explainRental(args: z.infer<(typeof TOOL_ARGS)["explain_rental"]>) {
  const db = await getDb();
  const rental = await rentalById(db, args.rental_id);
  if (!rental) throw new ToolRefusal(`There is no rental ${args.rental_id}.`);
  const [events, assessment, refunds, disputes, returned] = await Promise.all([
    eventsFor(db, rental.id),
    latestAssessment(db, rental.id),
    refundsFor(db, rental.id),
    disputesFor(db, rental.id),
    disputeReturns(db, rental.id),
  ]);
  const settled = rental.status === "settled" || rental.status === "disputed";
  const captures = refundableCaptures(rental, refunds, returned);
  // The dashboard's own arithmetic, so the agent and the Kept KPI agree.
  const split = settlementMoney(
    rental,
    refunds,
    disputes.map((d) => ({ ...d, fundMovements: d.paypal.fund_movements ?? [] })),
  );
  return {
    rental: {
      id: rental.id,
      item: catalogItem(rental.itemId).name,
      renter: renterFirstName(rental.customerName),
      pickup_day: rental.startDate,
      return_day: rental.endDate,
      status: STATUS[rental.status].label,
      cancelled_by: rental.cancelledBy,
    },
    money: {
      rental_fee: formatUsd(rental.feeCents),
      deposit_held: rental.authorizedCents ? formatUsd(rental.authorizedCents) : null,
      first_hold_at: originalHoldTime(rental),
      hold_expires_at: rental.authorizationExpiresAt,
      hold_renewed: Boolean(rental.parentAuthorizationId),
      captured_from_deposit: settled ? formatUsd(split.captured) : null,
      released_to_renter: settled ? formatUsd(split.released) : null,
      charged_above_deposit: settled && split.extra ? formatUsd(split.extra) : null,
      refunded_of_what_settling_took: settled ? formatUsd(split.refundedAfter) : null,
      returned_through_disputes: settled ? formatUsd(split.disputeReturned) : null,
      kept_after_refunds_and_disputes: settled ? formatUsd(split.kept) : null,
      refunds: refunds
        .filter((r) => r.state !== "refused")
        .map((r) => ({
          amount: formatUsd(r.amountCents),
          of_capture: r.captureId === rental.feeCaptureId ? "the rental fee" : r.captureId === rental.extraCaptureId ? "the charge above the deposit" : "the charge from the deposit",
          state: isRefunded(r) ? "refunded" : r.state === "requested" ? "sent, no answer from PayPal yet" : (r.paypalStatus ?? r.state),
          paypal_refund_id: r.refundId,
          made_by: r.source === "webhook" ? "outside the counter (reported by PayPal)" : "the counter",
        })),
      left_to_refund: captures.map((c) => ({ capture_id: c.captureId, of: c.label, captured: formatUsd(c.capturedCents), left: formatUsd(c.leftCents) })),
      paypal_ids: {
        booking_order: rental.bookingOrderId,
        fee_capture: rental.feeCaptureId,
        first_authorization: rental.parentAuthorizationId ?? rental.authorizationId,
        current_authorization: rental.authorizationId,
        settlement_capture: rental.settlementCaptureId,
        charge_above_deposit: rental.extraCaptureId,
      },
    },
    findings: (assessment?.findings ?? []).map((f) => ({
      found: f.item,
      kind: f.kind,
      price_entry: f.price?.label ?? null,
      price: f.price ? formatUsd(f.price.cents) : null,
      ai_decision: f.decision,
      outcome: findingOutcome(f, settled).outcome,
      charged: settled && isCharged(f) ? formatUsd(f.price!.cents) : formatUsd(0),
    })),
    disputes: disputes.map((d) => ({ id: d.id, reason: d.reason, status: d.status, outcome: d.outcome, disputed: d.amountCents === null ? null : formatUsd(d.amountCents), refunded_by_paypal: d.refundedCents ? formatUsd(d.refundedCents) : null })),
    audit_trail: {
      entries: events.length,
      chain_intact: firstBrokenLink(events) === null,
      events: events.map((e) => ({
        at: e.at,
        by: e.actor,
        what: eventLabel(e.type),
        ...Object.fromEntries(Object.entries(e.data).filter(([k, v]) => SAFE_EVENT_KEYS.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null))),
      })),
    },
  };
}

// ─── draft_refund ────────────────────────────────────────────

/**
 * A refund proposal under the same limits the counter's refundCharge applies
 * before it claims a refund (lib/rentals/refunds.ts): the rental exists, no
 * PayPal dispute on it is open, it is settled or a booking cancelled after
 * payment, the capture is one the counter may refund, and the amount fits
 * what is left on it after earlier refunds and money a dispute returned.
 * Nothing is claimed or sent: the result is a link to the rental page with
 * the form filled in, where a person presses Refund and confirms.
 */
export async function draftRefund(args: z.infer<(typeof TOOL_ARGS)["draft_refund"]>) {
  const db = await getDb();
  const rental = await rentalById(db, args.rental_id);
  if (!rental) throw new ToolRefusal(`There is no rental ${args.rental_id}.`);
  const disputes = await disputesFor(db, rental.id);
  if (rental.status === "disputed" || disputes.some((d) => d.status !== "RESOLVED")) {
    throw new ToolRefusal("This rental has an open PayPal dispute, so money goes back through the dispute desk on the rental page (an offer or accepting the claim), not a refund.");
  }
  if (rental.status !== "settled" && !cancelledAfterPayment(rental)) {
    throw new ToolRefusal(`Only a settled rental, or a booking cancelled after it was paid, can be refunded; ${rental.id} is ${STATUS[rental.status].label.toLowerCase()}.`);
  }
  const captures = refundableCaptures(rental, await refundsFor(db, rental.id), await disputeReturns(db, rental.id));
  const capture = args.capture_id ? captures.find((c) => c.captureId === args.capture_id) : (captures.find((c) => c.leftCents >= args.amount_cents) ?? captures[0]);
  if (!capture) {
    throw new ToolRefusal(args.capture_id ? `Capture ${args.capture_id} is not one the counter can refund on ${rental.id}.` : `${rental.id} took nothing that can be refunded here.`);
  }
  if (capture.leftCents === 0) throw new ToolRefusal(`Everything taken for ${capture.label} on ${rental.id} has already been refunded.`);
  if (args.amount_cents > capture.leftCents) {
    throw new ToolRefusal(`At most ${formatUsd(capture.leftCents)} is left to refund on ${capture.label} (${formatUsd(capture.capturedCents)} taken). Draft ${formatUsd(capture.leftCents)} or less.`);
  }
  const query = new URLSearchParams({ refund: String(args.amount_cents), capture: capture.captureId, reason: args.reason });
  return {
    status: "draft, not sent",
    rental_id: rental.id,
    item: catalogItem(rental.itemId).name,
    renter: renterFirstName(rental.customerName),
    amount: formatUsd(args.amount_cents),
    amount_cents: args.amount_cents,
    of: capture.label,
    capture_id: capture.captureId,
    left_after: formatUsd(capture.leftCents - args.amount_cents),
    reason: args.reason,
    confirm_at: `/shop/rentals/${rental.id}?${query.toString()}#refunds`,
    next_step: "Nothing was sent to PayPal. A person opens the rental, checks the filled-in refund form and presses Refund, then confirms.",
  };
}

// ─── Dispatch ────────────────────────────────────────────────

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string; issues?: string[] };

export async function runAgentTool(tool: string, rawArgs: unknown, now = new Date()): Promise<ToolResult> {
  if (!(TOOL_NAMES as string[]).includes(tool)) return { ok: false, error: `Unknown tool ${tool}.` };
  const name = tool as ToolName;
  const parsed = TOOL_ARGS[name].safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: "The arguments are not valid.", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`) };
  try {
    if (name === "holds_needing_attention") return { ok: true, result: await holdsNeedingAttention(parsed.data as never, now) };
    if (name === "explain_rental") return { ok: true, result: await explainRental(parsed.data as never) };
    return { ok: true, result: await draftRefund(parsed.data as never) };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false, error: err.message };
    throw err;
  }
}
