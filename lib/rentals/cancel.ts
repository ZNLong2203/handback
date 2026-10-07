import "server-only";
import { getDb } from "@/lib/db/client";
import { shortDate } from "@/lib/dates";
import { publish } from "@/lib/live";
import { formatUsd, type Cents } from "@/lib/money";
import { depositGateway } from "@/lib/paypal";
import type { BookingCapture } from "@/lib/paypal/gateway";
import { appendEvent } from "./audit";
import { cancellationRefund, cancellationTerms, type CancellationRefund, type CancellationTerms } from "./cancellation";
import { mandateCancellation, openMandate } from "./mandate";
import { claimRefund, disputeReturns, feeCapture, nextRefundSeq, refundsFor, sendRefund, type StoredRefund } from "./refunds";
import { rentalById, rentalByToken, updateRental } from "./repo";
import { paypalStep } from "./service";
import { feePending } from "./status";
import { PayPalStepError, UserError, type Rental } from "./types";

// Cancelling a booking before pickup. A paid booking gets part of its fee
// back, by the cancellation policy in its mandate (the renter) or by the
// amount staff choose (the counter), through the counter's refund code: a
// numbered refund claimed under the rental's row lock, PayPal-Request-Id
// refund:<rental>:<n>, the same resend window and webhook reconciliation.
// An unpaid draft is just marked cancelled; nothing was captured, so PayPal
// is not called. Either way the unit goes back on the schedule, because a
// cancelled rental holds no days (lib/schedule/spans.ts).

/**
 * The cancellation terms a booking was made on: the ones its deposit mandate
 * fixed (version 2), else, for bookings made before mandates carried them or
 * whose mandate no longer verifies, the shop's policy today applied to its
 * pickup day.
 */
export function termsFor(rental: Rental): CancellationTerms {
  const opened = rental.mandateJson && rental.mandateSha256 ? openMandate(rental.mandateJson, rental.mandateSha256) : null;
  return (opened?.intact ? mandateCancellation(opened.mandate) : null) ?? cancellationTerms(rental.startDate);
}

export type Canceller = "renter" | "staff";

export type CancelQuote = {
  /** Why it cannot be cancelled now, said to whoever asks; null when it can. */
  blocked: string | null;
  /** The fee was captured, so there is something to refund. */
  paid: boolean;
  terms: CancellationTerms;
  /** The policy's share at this moment. */
  policy: CancellationRefund;
  /** Of the fee, what is still left to refund: the most the counter may give back. */
  feeLeftCents: Cents;
  /** What the renter gets back if they cancel now: the policy's share, never more than is left. */
  refundCents: Cents;
};

const PICKED_UP = ["out", "inspecting", "customer_review", "responded", "settled", "disputed"];

/**
 * Whether a rental can be cancelled now, and what the policy refunds. Pure:
 * the pages call it to draw the button and the service calls it again under
 * the row lock before anything changes.
 */
export function quoteCancellation(rental: Rental, state: { feeLeftCents: Cents; openDispute: boolean }, who: Canceller, now: Date): CancelQuote {
  const terms = termsFor(rental);
  const paid = rental.status !== "draft" && rental.feeCaptureId !== null;
  const policy = paid ? cancellationRefund(rental.feeCents, terms, now) : { percent: 0, refundCents: 0, until: null };
  const quote = { blocked: null, paid, terms, policy, feeLeftCents: paid ? state.feeLeftCents : 0, refundCents: paid ? Math.min(policy.refundCents, state.feeLeftCents) : 0 };
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
    if (state.openDispute) {
      return renter
        ? "You have an open case with PayPal about this booking, so it cannot be cancelled here while PayPal decides it."
        : "The customer has an open PayPal dispute on this booking, so it cannot be cancelled here: answer it at the dispute desk on this page. Money given back belongs in the dispute, where PayPal counts it.";
    }
    if (rental.holdRequestedAt && !rental.authorizationId) {
      return renter
        ? "The shop has started your pickup, so the booking can no longer be cancelled here. Ask at the counter."
        : `The deposit hold was sent to PayPal at ${new Date(rental.holdRequestedAt).toISOString().slice(11, 16)} UTC and its answer has not been recorded. Press Hold again to get PayPal's answer (the same request cannot hold twice); a rental that is out is taken back as a return.`;
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
  return { refunds, fee, feeLeftCents: fee?.leftCents ?? 0, openDispute: open.length > 0 };
}

export type CancelResult = {
  /** False when it was already cancelled (a second press): nothing was done again. */
  cancelled: boolean;
  refund: StoredRefund | null;
  /** When the refund was claimed but PayPal did not complete it: why, in words. */
  refundProblem: string | null;
};

type How = { by: "renter"; expectedRefundCents: Cents | null } | { by: "staff"; refundCents: Cents; reason: string };

/** The renter cancels on their own page. `expectedRefundCents` is the amount the page showed; a different one now is refused, not refunded. */
export async function cancelAsRenter(token: string, expectedRefundCents: Cents | null, now = new Date()): Promise<CancelResult> {
  const rental = await rentalByToken(await getDb(), token);
  if (!rental) throw new UserError("This link is not valid.");
  return cancelBooking(rental.id, { by: "renter", expectedRefundCents }, now);
}

/** The counter cancels, refunding any amount from $0.00 up to what is left of the fee, with a reason the renter sees. */
export async function cancelAtCounter(rentalId: string, input: { refundCents: Cents; reason: string }, now = new Date()): Promise<CancelResult> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new UserError("Say briefly why the booking is cancelled. The customer sees it on their page.");
  if (reason.length > 200) throw new UserError("Keep the reason under 200 characters.");
  if (!Number.isSafeInteger(input.refundCents) || input.refundCents < 0) throw new UserError("Enter the refund in dollars and cents, $0.00 or more.");
  return cancelBooking(rentalId, { by: "staff", refundCents: input.refundCents, reason }, now);
}

async function cancelBooking(rentalId: string, how: How, now: Date): Promise<CancelResult> {
  const db = await getDb();
  const outcome = await db.tx(async (tx) => {
    // One decision at a time per rental: a second press, the counter holding
    // the deposit and PayPal's webhooks all take this lock first.
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
      if (how.expectedRefundCents !== null && how.expectedRefundCents !== refundCents) {
        throw new UserError(
          `The refund for cancelling is now ${formatUsd(refundCents)}, not ${formatUsd(how.expectedRefundCents)}: the cancellation policy moved on to its next step. Nothing was cancelled. Reload the page to see the new amount.`,
        );
      }
      note = `You cancelled booking ${rental.id}: ${quote.policy.percent}% of the rental fee back under the shop's cancellation policy.`;
    } else {
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
 * The renter cancelled an unpaid booking while PayPal was capturing the fee
 * (they approved in another window, or PayPal's webhook did it): the capture
 * went through after the booking was cancelled. Called by confirmBooking. The
 * capture is recorded on the cancelled booking and refunded in full, through
 * the same refund code.
 */
export async function refundCaptureAfterCancel(rentalId: string, paid: BookingCapture): Promise<void> {
  const db = await getDb();
  const claimed = await db.tx(async (tx) => {
    await tx.query("select id from rentals where id = $1 for update", [rentalId]);
    const rental = (await rentalById(tx, rentalId))!;
    if (rental.status !== "cancelled" || !rental.cancelledAt || rental.feeCaptureId) return null;
    await updateRental(tx, rentalId, { fee_capture_id: paid.captureId, vault_id: paid.vaultId ?? null, payer_email: paid.payerEmail ?? null, cancel_refund_cents: paid.capturedCents });
    await appendEvent(tx, rentalId, "paypal", "booking.paid_after_cancel", { captureId: paid.captureId, feeCents: paid.capturedCents });
    if (paid.capturedCents <= 0) return null;
    const claim = {
      captureId: paid.captureId,
      cents: paid.capturedCents,
      reason: `Booking ${rental.id} was cancelled on ${shortDate(rental.cancelledAt)} before this payment went through, so all of it is refunded.`,
      seq: nextRefundSeq(await refundsFor(tx, rentalId)),
    };
    return { ...claim, id: await claimRefund(tx, rentalId, claim) };
  });
  if (!claimed) return;
  publish(rentalId, "booking.paid_after_cancel");
  try {
    await sendRefund(rentalId, claimed, "customer", "refund the rental fee");
  } catch (err) {
    // Recorded on the refund row and in the audit log; the counter can send it again.
    if (!(err instanceof PayPalStepError)) throw err;
  }
}
