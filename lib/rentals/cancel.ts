import "server-only";
import { getDb } from "@/lib/db/client";
import { shortDate } from "@/lib/dates";
import { publish } from "@/lib/live";
import { formatUsd, type Cents } from "@/lib/money";
import { depositGateway } from "@/lib/paypal";
import type { BookingCapture } from "@/lib/paypal/gateway";
import { appendEvent } from "./audit";
import { cancellationRefund, cancellationTerms, type CancellationRefund, type CancellationTerms } from "./cancellation";
import { mandateCancellation, mandateOnRecord } from "./mandate";
import { claimRefund, disputeReturns, feeCapture, isRefunded, nextRefundSeq, refundsFor, sendRefund, type StoredRefund } from "./refunds";
import { eventsFor, rentalById, rentalByToken, updateRental } from "./repo";
import { confirmBooking, paypalStep } from "./service";
import { feePending } from "./status";
import { PayPalStepError, UserError, type AuditEvent, type Rental } from "./types";

// Cancelling a booking before pickup. A paid booking gets part of its fee
// back, by the cancellation terms in its mandate (the renter) or by the
// amount staff choose (the counter), through the counter's refund code: a
// numbered refund claimed under the rental's row lock, PayPal-Request-Id
// refund:<rental>:<n>, the same resend window and webhook reconciliation.
// An unpaid draft is just marked cancelled; nothing was captured, so PayPal
// is not called. Either way the unit goes back on the schedule, because a
// cancelled rental holds no days (lib/schedule/spans.ts).

/**
 * How long a PayPal call claimed on the rental (the fee capture, the deposit
 * hold) can still be waiting for its answer: three tries of 20 seconds with
 * backoff (lib/paypal/sdk.ts) take about 70 seconds. An older claim with no
 * answer recorded means the answer was lost.
 */
export const CLAIM_STALE_MS = 2 * 60_000;
const stale = (iso: string | null, clock: Date) => iso !== null && clock.getTime() - Date.parse(iso) >= CLAIM_STALE_MS;

export type BookingTerms = {
  terms: CancellationTerms;
  /** True when the terms come from the deposit mandate the renter approved in PayPal; false for today's policy. */
  fromMandate: boolean;
};

/**
 * The cancellation terms a booking was made on: the ones its deposit mandate
 * fixed (version 2), when that mandate passes the same check as every hold
 * and charge (mandateOnRecord: the hash the audit chain recorded at booking,
 * this rental's id, an intact chain). Otherwise, for a version 1 mandate or
 * one that does not verify, the shop's policy today applied to its pickup day.
 */
export function termsFor(rental: Rental, events: AuditEvent[]): BookingTerms {
  const record = mandateOnRecord(rental, events);
  const fixed = record.kind === "trusted" ? mandateCancellation(record.mandate) : null;
  return fixed ? { terms: fixed, fromMandate: true } : { terms: cancellationTerms(rental.startDate), fromMandate: false };
}

export type Canceller = "renter" | "staff";

export type CancelQuote = {
  /** Why it cannot be cancelled now, said to whoever asks; null when it can. */
  blocked: string | null;
  /** The fee was captured, so there is something to refund. */
  paid: boolean;
  terms: CancellationTerms;
  termsFromMandate: boolean;
  /** The policy's share at this moment. */
  policy: CancellationRefund;
  /** Of the fee, what is still left to refund: the most the counter may give back. */
  feeLeftCents: Cents;
  /** What the renter gets back if they cancel now: the policy's share, never more than is left. */
  refundCents: Cents;
  /** The deposit hold's answer was lost long enough ago that staff may confirm in PayPal that no hold is open (clearHoldClaim). */
  holdClaimStale: boolean;
};

export type CancelState = { feeLeftCents: Cents; openDispute: boolean; events: AuditEvent[] };

const PICKED_UP = ["out", "inspecting", "customer_review", "responded", "settled", "disputed"];

/**
 * Whether a rental can be cancelled now, and what the policy refunds. The
 * pages call it to draw the button and the service calls it again under the
 * row lock before anything changes. `now` is the moment the policy is applied
 * at; `clock` ages claims on PayPal calls and is the real time.
 */
export function quoteCancellation(rental: Rental, state: CancelState, who: Canceller, now: Date, clock = new Date()): CancelQuote {
  const { terms, fromMandate } = termsFor(rental, state.events);
  const paid = rental.status !== "draft" && rental.feeCaptureId !== null;
  const policy = paid ? cancellationRefund(rental.feeCents, terms, now) : { percent: 0, refundCents: 0, until: null };
  const holdClaimed = rental.status === "booked" && rental.holdRequestedAt !== null && !rental.authorizationId;
  const quote = {
    paid,
    terms,
    termsFromMandate: fromMandate,
    policy,
    feeLeftCents: paid ? state.feeLeftCents : 0,
    refundCents: paid ? Math.min(policy.refundCents, state.feeLeftCents) : 0,
    holdClaimStale: holdClaimed && who === "staff" && stale(rental.holdRequestedAt, clock),
  };
  const renter = who === "renter";
  const blocked = (() => {
    if (rental.status === "cancelled") return "This booking is already cancelled.";
    if (PICKED_UP.includes(rental.status)) {
      return renter
        ? "You have picked the item up, so the booking can no longer be cancelled. Bring it back to the shop; the deposit is settled from the photos."
        : "The item has been picked up, so this is a return, not a cancellation: take it back with a return photo.";
    }
    if (feePending(rental)) {
      return renter
        ? "PayPal is still processing your payment. Once it is confirmed, this page lets you cancel under the cancellation policy."
        : "PayPal is still processing the fee. Once PayPal confirms or declines it, the booking can be cancelled.";
    }
    if (rental.status === "draft" && rental.captureRequestedAt && !stale(rental.captureRequestedAt, clock)) {
      return renter
        ? "PayPal is taking your payment right now. Reload this page in a minute or two: it then shows what cancelling gives back."
        : "PayPal is capturing the fee right now. Reload in a minute or two to cancel with its answer on record.";
    }
    if (state.openDispute) {
      return renter
        ? "You have an open case with PayPal about this booking, so it cannot be cancelled here while PayPal decides it."
        : "The customer has an open PayPal dispute on this booking, so it cannot be cancelled here: answer it at the dispute desk on this page. Money given back belongs in the dispute, where PayPal counts it.";
    }
    if (holdClaimed) {
      if (renter) return "The shop has started your pickup, so the booking can no longer be cancelled here. Ask at the counter.";
      const at = `${new Date(rental.holdRequestedAt!).toISOString().slice(11, 16)} UTC`;
      return quote.holdClaimStale
        ? `The deposit hold was sent to PayPal at ${at} and PayPal's answer was lost. Press Hold again to get it (the same request cannot hold twice). If holding is no longer possible, look in PayPal for a payment with invoice ID ${rental.id}-deposit, void any hold you find, then confirm below that no hold is open.`
        : `The deposit hold was sent to PayPal at ${at} and its answer has not arrived yet. Reload in a minute or two.`;
    }
    return null;
  })();
  return { ...quote, blocked };
}

/** Reads what quoteCancellation needs from the database. */
async function cancelState(tx: Parameters<typeof refundsFor>[0], rental: Rental) {
  const refunds = await refundsFor(tx, rental.id);
  const open = await tx.query("select id from disputes where rental_id = $1 and status <> 'RESOLVED' limit 1", [rental.id]);
  const fee = feeCapture(rental, refunds, await disputeReturns(tx, rental.id));
  return { refunds, fee, feeLeftCents: fee?.leftCents ?? 0, openDispute: open.length > 0, events: await eventsFor(tx, rental.id) };
}

export type CancelResult = {
  /** False when it was already cancelled (a second press): nothing was done again. */
  cancelled: boolean;
  refund: StoredRefund | null;
  /** When the refund was claimed but PayPal did not complete it: why, in words. */
  refundProblem: string | null;
};

/** What the renter's page showed when they pressed Cancel: whether the fee was paid, and the refund. */
export type ShownQuote = { paid: boolean; refundCents: Cents };

type How = { by: "renter"; shown: ShownQuote | null } | { by: "staff"; refundCents: Cents; reason: string; paid: boolean | null };

/**
 * The renter cancels on their own page. `shown` is what the page showed:
 * when the booking was paid meanwhile, or the policy moved on to its next
 * step, nothing is cancelled and the page shows the new amount.
 */
export async function cancelAsRenter(token: string, shown: ShownQuote | null, now = new Date()): Promise<CancelResult> {
  const rental = await rentalByToken(await getDb(), token);
  if (!rental) throw new UserError("This link is not valid.");
  return cancelBooking(rental.id, { by: "renter", shown }, now);
}

/**
 * The counter cancels, refunding any amount from $0.00 up to what is left of
 * the fee, with a reason the renter sees. `paid` is whether the counter's
 * page showed the fee as paid; if that changed, nothing is cancelled.
 */
export async function cancelAtCounter(rentalId: string, input: { refundCents: Cents; reason: string; paid?: boolean | null }, now = new Date()): Promise<CancelResult> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new UserError("Say briefly why the booking is cancelled. The customer sees it on their page.");
  if (reason.length > 200) throw new UserError("Keep the reason under 200 characters.");
  if (!Number.isSafeInteger(input.refundCents) || input.refundCents < 0) throw new UserError("Enter the refund in dollars and cents, $0.00 or more.");
  return cancelBooking(rentalId, { by: "staff", refundCents: input.refundCents, reason, paid: typeof input.paid === "boolean" ? input.paid : null }, now);
}

async function cancelBooking(rentalId: string, how: How, now: Date): Promise<CancelResult> {
  const db = await getDb();
  const before = await rentalById(db, rentalId);
  if (!before) throw new UserError("That rental does not exist.");
  // An unpaid booking whose fee capture was sent long ago with no answer
  // recorded: ask PayPal whether it went through before cancelling.
  if (before.status === "draft" && !before.feeCaptureId && stale(before.captureRequestedAt, new Date())) await settleUnansweredCapture(before);

  const outcome = await db.tx(async (tx) => {
    // One decision at a time per rental: a second press, the counter holding
    // the deposit, the fee capture and PayPal's webhooks all take this lock.
    const locked = await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    if (locked.length === 0) throw new UserError("That rental does not exist.");
    const rental = (await rentalById(tx, rentalId))!;
    if (rental.status === "cancelled" && rental.cancelledAt) return { kind: "already" as const };
    const state = await cancelState(tx, rental);
    const quote = quoteCancellation(rental, state, how.by, now);
    if (quote.blocked) throw new UserError(quote.blocked);

    let refundCents: Cents;
    let note: string;
    if (how.by === "renter") {
      refundCents = quote.refundCents;
      if (how.shown && how.shown.paid !== quote.paid) {
        throw new UserError(
          quote.paid
            ? `Your payment went through since this page was drawn, so cancelling now gives back ${formatUsd(refundCents)} of the ${formatUsd(rental.feeCents)} rental fee. Nothing was cancelled. Reload the page to see it.`
            : "This page is out of date. Nothing was cancelled. Reload it and try again.",
        );
      }
      if (how.shown && how.shown.refundCents !== refundCents) {
        throw new UserError(
          `The refund for cancelling is now ${formatUsd(refundCents)}, not ${formatUsd(how.shown.refundCents)}: the cancellation policy moved on to its next step. Nothing was cancelled. Reload the page to see the new amount.`,
        );
      }
      note = `You cancelled booking ${rental.id}: ${quote.policy.percent}% of the rental fee back under the shop's cancellation policy.`;
    } else {
      if (how.paid !== null && how.paid !== quote.paid) {
        throw new UserError(
          quote.paid
            ? "The fee was paid since this page was drawn. Nothing was cancelled. Reload the page to choose the refund."
            : "This page is out of date. Nothing was cancelled. Reload it and try again.",
        );
      }
      if (how.refundCents > quote.feeLeftCents) {
        throw new UserError(
          quote.paid ? `At most ${formatUsd(quote.feeLeftCents)} of the rental fee is left to refund.` : "The fee was never paid, so there is nothing to refund. Cancel with $0.00.",
        );
      }
      refundCents = how.refundCents;
      note = how.reason;
    }

    const moved = await updateRental(
      tx,
      rentalId,
      {
        status: "cancelled",
        cancelled_at: now.toISOString(),
        cancelled_by: how.by,
        cancel_reason: how.by === "staff" ? how.reason : null,
        cancel_refund_cents: refundCents,
      },
      rental.status,
    );
    if (!moved) throw new UserError("The rental changed while cancelling. Reload the page and try again.");
    // A schedule suggestion about this booking no longer applies; its unit is free again.
    await tx.query("update schedule_proposals set status = 'superseded', decided_at = now(), decision_note = $2 where rental_id = $1 and status = 'pending'", [
      rentalId,
      "The booking was cancelled.",
    ]);
    const claim =
      refundCents > 0 && state.fee
        ? { captureId: state.fee.captureId, cents: refundCents, reason: note, seq: nextRefundSeq(state.refunds) }
        : null;
    const claimed = claim ? { ...claim, id: await claimRefund(tx, rentalId, claim) } : null;
    await appendEvent(tx, rentalId, how.by === "renter" ? "customer" : "staff", "booking.cancelled", {
      by: how.by,
      paid: quote.paid,
      feeCents: rental.feeCents,
      policyPercent: quote.policy.percent,
      policyRefundCents: quote.policy.refundCents,
      termsFrom: quote.termsFromMandate ? "mandate" : "policy",
      refundCents,
      reason: how.by === "staff" ? how.reason : null,
      refundNumber: claimed?.seq ?? null,
      unitId: rental.unitId ?? null,
    });
    return { kind: "cancelled" as const, claimed, authorizationId: rental.authorizationId };
  });
  if (outcome.kind === "already") return { cancelled: false, refund: null, refundProblem: null };
  publish(rentalId, "booking.cancelled");

  // No deposit is held before pickup. Should one exist anyway, release it with
  // the request id every release of this rental's hold uses.
  if (outcome.authorizationId) await releaseHold(rentalId, outcome.authorizationId);
  if (!outcome.claimed) return { cancelled: true, refund: null, refundProblem: null };
  try {
    const refund = await sendRefund(rentalId, outcome.claimed, how.by === "renter" ? "customer" : "staff", "refund the rental fee");
    return { cancelled: true, refund, refundProblem: null };
  } catch (err) {
    // The booking stays cancelled: the refund row says what PayPal did, and
    // the counter can send it again or refund the fee from its page.
    if (!(err instanceof UserError)) throw err;
    return { cancelled: true, refund: null, refundProblem: err.message };
  }
}

/**
 * The fee capture of an unpaid booking was sent and its answer never came.
 * Reads the booking order back (Orders v2 GET): with a capture on it,
 * confirmBooking records it, sending the capture again with the same
 * request id, so the booking is paid and the cancel that follows is judged
 * as a paid one; without one, the capture did not go through and the claim
 * is cleared.
 */
async function settleUnansweredCapture(rental: Rental): Promise<void> {
  const orderId = rental.bookingOrderId;
  const found = orderId ? await paypalStep(rental.id, "read the booking order", () => depositGateway().getBookingOrder(orderId)) : null;
  if (found && orderId) {
    await confirmBooking(orderId);
    return;
  }
  const db = await getDb();
  await db.tx(async (tx) => {
    const cleared = await tx.query(
      "update rentals set capture_requested_at = null where id = $1 and status = 'draft' and fee_capture_id is null and capture_requested_at < $2 returning id",
      [rental.id, new Date(Date.now() - CLAIM_STALE_MS).toISOString()],
    );
    if (cleared.length) await appendEvent(tx, rental.id, "system", "booking.capture_checked", { orderId, requestedAt: rental.captureRequestedAt, captured: false });
  });
}

/**
 * Staff confirm that no deposit hold is open for a booking whose hold
 * request's answer was lost, after looking in PayPal for its invoice id
 * (`<rental id>-deposit`) and voiding any hold there. The claim is cleared,
 * so the booking can be cancelled. Only once the claim is stale, so it never
 * races a hold still waiting for PayPal.
 */
export async function clearHoldClaim(rentalId: string, clock = new Date()): Promise<void> {
  const db = await getDb();
  await db.tx(async (tx) => {
    const locked = await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    if (locked.length === 0) throw new UserError("That rental does not exist.");
    const rental = (await rentalById(tx, rentalId))!;
    if (rental.status !== "booked" || !rental.holdRequestedAt || rental.authorizationId) throw new UserError("There is no unanswered deposit hold on this booking.");
    if (!stale(rental.holdRequestedAt, clock)) throw new UserError("The hold was sent to PayPal less than two minutes ago. Wait for PayPal's answer first.");
    await tx.query("update rentals set hold_requested_at = null where id = $1", [rentalId]);
    await appendEvent(tx, rentalId, "staff", "deposit.claim_cleared", {
      requestedAt: rental.holdRequestedAt,
      invoiceId: `${rentalId}-deposit`,
      note: "Staff confirmed in PayPal that no deposit hold for this rental is open.",
    });
  });
  publish(rentalId, "deposit.claim_cleared");
}

async function releaseHold(rentalId: string, authorizationId: string) {
  await paypalStep(rentalId, "release the deposit", () => depositGateway().release(authorizationId, `release:${rentalId}`));
  const db = await getDb();
  await db.tx(async (tx) => {
    await updateRental(tx, rentalId, { released_cents: (await rentalById(tx, rentalId))?.authorizedCents ?? null });
    await appendEvent(tx, rentalId, "paypal", "deposit.released", { authorizationId, capturedCents: 0, reason: "cancelled" });
  });
  publish(rentalId, "deposit.released");
}

/**
 * A fee capture that landed after its unpaid booking was cancelled. The
 * capture claim makes this rare: it takes a capture call that hung past
 * CLAIM_STALE_MS while a cancel cleared its claim. Called by confirmBooking
 * and by PayPal's PAYMENT.CAPTURE.COMPLETED webhook. A completed capture is
 * recorded on the cancelled booking and refunded in full through the same
 * refund code; a PENDING one is recorded and audited, and refunded when
 * PayPal's webhook says it completed. Bookings cancelled after payment are
 * never touched here.
 */
export async function refundCaptureAfterCancel(rentalId: string, paid: BookingCapture): Promise<void> {
  const db = await getDb();
  const claimed = await db.tx(async (tx) => {
    await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    const rental = (await rentalById(tx, rentalId))!;
    const unpaidWhenCancelled = (await eventsFor(tx, rentalId)).some((e) => e.type === "booking.cancelled" && e.data.paid === false);
    if (rental.status !== "cancelled" || !rental.cancelledAt || !unpaidWhenCancelled) return null;
    if (rental.feeCaptureId && rental.feeCaptureId !== paid.captureId) return null;
    const refunds = await refundsFor(tx, rentalId);
    if (refunds.some((r) => r.captureId === paid.captureId && (r.state === "requested" || isRefunded(r)))) return null;
    if (!rental.feeCaptureId) {
      await updateRental(tx, rentalId, { fee_capture_id: paid.captureId, vault_id: paid.vaultId ?? null, payer_email: paid.payerEmail ?? null });
    }
    if (paid.status === "PENDING") {
      await appendEvent(tx, rentalId, "paypal", "booking.pending_after_cancel", { captureId: paid.captureId, feeCents: paid.capturedCents });
      return null;
    }
    if (paid.status !== "COMPLETED") return null;
    await updateRental(tx, rentalId, { cancel_refund_cents: paid.capturedCents });
    await appendEvent(tx, rentalId, "paypal", "booking.paid_after_cancel", { captureId: paid.captureId, feeCents: paid.capturedCents });
    if (paid.capturedCents <= 0) return null;
    const claim = {
      captureId: paid.captureId,
      cents: paid.capturedCents,
      reason: `Booking ${rental.id} was cancelled on ${shortDate(rental.cancelledAt)} before this payment went through, so all of it is refunded.`,
      seq: nextRefundSeq(refunds),
    };
    return { ...claim, id: await claimRefund(tx, rentalId, claim) };
  });
  publish(rentalId, "booking.paid_after_cancel");
  if (!claimed) return;
  try {
    await sendRefund(rentalId, claimed, "customer", "refund the rental fee");
  } catch (err) {
    // Recorded on the refund row and in the audit log; the counter can send it again.
    if (!(err instanceof PayPalStepError)) throw err;
  }
}
