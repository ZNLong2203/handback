"use server";

import { refresh } from "next/cache";
import * as desk from "@/lib/disputes/service";
import { after } from "next/server";
import { formatUsd, parseUsdInput } from "@/lib/money";
import { cancelAsRenter, cancelAtCounter, type CancelResult } from "@/lib/rentals/cancel";
import { refundCharge, resendRefund } from "@/lib/rentals/refunds";
import * as svc from "@/lib/rentals/service";
import { polishMessages } from "@/lib/schedule/agent";
import { UserError, type Phase } from "@/lib/rentals/types";
import { requireStaff } from "@/lib/staff-access";
import { runInspection } from "@/lib/workflows/dispatch";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Server actions return their errors instead of throwing: a thrown error's
 * message is hidden from the browser in production, and people need to know
 * what went wrong and what to do.
 */
async function run<T>(fn: () => Promise<T>, after = true): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (after) refresh();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: "Something went wrong on our side. Nothing was charged; please try again." };
  }
}

/**
 * Every counter and dispute-desk action goes through here: the staff check
 * runs first, before any input is read or anything changes. Server actions can
 * be posted to from any path, so the check lives in the action, not in front
 * of the page. Without SHOP_ACCESS_CODE it always passes.
 */
function asStaff<T>(fn: () => Promise<T>, after = true): Promise<ActionResult<T>> {
  return run(async () => {
    await requireStaff();
    return fn();
  }, after);
}

// ─── Customer ───────────────────────────────────────────────

export async function startBookingAction(input: {
  itemId: string;
  name: string;
  email: string;
  startDate: string;
  endDate: string;
}) {
  return run(async () => {
    const { rentalId, orderId } = await svc.startBooking(input);
    return { rentalId, orderId };
  }, false);
}

export async function confirmBookingAction(orderId: string) {
  return run(() => svc.confirmBooking(orderId), false);
}

export async function acknowledgeCheckoutAction(token: string) {
  return run(() => svc.acknowledgeCheckout(token));
}

export async function respondAction(token: string, answers: { findingId: string; answer: "accept" | "contest"; note?: string }[]) {
  return run(() => svc.respondAsCustomer(token, answers));
}

/** What a cancel button says afterwards: nothing when it all went through, else what is still waiting. */
function cancelOutcome(r: CancelResult): string | undefined {
  if (!r.cancelled) return "This booking was already cancelled.";
  if (r.refundProblem) return `Cancelled. The refund has not gone through yet: ${r.refundProblem}`;
  if (r.refund && r.refund.state !== "done") return `Cancelled. The refund of ${formatUsd(r.refund.amountCents)} was sent to PayPal; its answer has not arrived yet.`;
  return undefined;
}

/**
 * The renter cancels on their own page. `expectedRefundCents` is the refund
 * the page showed them; if the policy has moved on since, nothing is
 * cancelled and they see the new amount.
 */
export async function cancelBookingAction(token: string, expectedRefundCents: number | null) {
  return run(async () => cancelOutcome(await cancelAsRenter(String(token), typeof expectedRefundCents === "number" ? expectedRefundCents : null)));
}

// ─── Counter ────────────────────────────────────────────────

export async function addPhotoAction(form: FormData) {
  const rentalId = String(form.get("rentalId") ?? "");
  const phase = String(form.get("phase") ?? "") as Phase;
  const sample = form.get("sample");
  const file = form.get("photo");
  return asStaff(async () => {
    if (phase !== "checkout" && phase !== "checkin") throw new UserError("Unknown photo step.");
    if (typeof sample === "string" && sample) {
      await svc.addPhoto(rentalId, phase, { sample });
    } else if (file instanceof File && file.size > 0) {
      if (!file.type.startsWith("image/")) throw new UserError("That file is not a photo.");
      await svc.addPhoto(rentalId, phase, { bytes: Buffer.from(await file.arrayBuffer()) });
    } else {
      throw new UserError("Choose a photo first.");
    }
  });
}

export async function holdDepositAction(rentalId: string) {
  return asStaff(() => svc.holdDeposit(rentalId));
}

/** Runs on Render Workflows when the deployment is set up for it, in this process otherwise. */
export async function inspectAction(rentalId: string) {
  return asStaff(() => runInspection(rentalId));
}

export async function setStaffDecisionAction(rentalId: string, findingId: string, staff: "keep" | "waive") {
  return asStaff(() => svc.setStaffDecision(rentalId, findingId, staff));
}

export async function sendToCustomerAction(rentalId: string) {
  return asStaff(() => svc.sendToCustomer(rentalId));
}

export async function resolveContestAction(rentalId: string, findingId: string, resolution: "charge" | "waive") {
  return asStaff(() => svc.resolveContest(rentalId, findingId, resolution));
}

export async function settleAction(rentalId: string) {
  return asStaff(async () => {
    await svc.settle(rentalId);
    // The schedule agent has already planned around any repair; Gemini words its customer messages after the response.
    after(() => polishMessages().catch((err) => console.error("message polish failed", err)));
  });
}

/**
 * Refunds part or all of a settled charge. The form sends dollars as typed;
 * the service checks whole cents, what is left on that capture, and the
 * refund number that keeps a second submit from refunding twice.
 */
export async function refundAction(rentalId: string, input: { captureId: string; amount: string; reason: string; seq: number }) {
  return asStaff(async () => {
    const cents = parseUsdInput(String(input?.amount ?? ""));
    if (cents === null) throw new UserError("Enter the amount in dollars and cents, for example 12.50.");
    await refundCharge(String(rentalId), { captureId: String(input?.captureId ?? ""), cents, reason: String(input?.reason ?? ""), seq: Number(input?.seq) });
  });
}

/** The counter cancels a booking before pickup, refunding the amount typed (from $0.00 up to the fee left), with a reason the renter sees. */
export async function cancelAtCounterAction(rentalId: string, input: { amount: string; reason: string }) {
  return asStaff(async () => {
    const cents = parseUsdInput(String(input?.amount ?? ""));
    if (cents === null) throw new UserError("Enter the refund in dollars and cents, for example 45.00, or 0.");
    return cancelOutcome(await cancelAtCounter(String(rentalId), { refundCents: cents, reason: String(input?.reason ?? "") }));
  });
}

/** Sends a refund whose PayPal answer was lost again, unchanged, within the hour PayPal surely keeps its request id. */
export async function resendRefundAction(rentalId: string, seq: number) {
  return asStaff(async () => {
    await resendRefund(String(rentalId), Number(seq));
  });
}

// ─── Dispute desk ───────────────────────────────────────────

export async function findDisputesAction(rentalId: string) {
  return asStaff(async () => {
    const found = await desk.findDisputes(rentalId);
    return found === 0 ? "PayPal reports no dispute on this rental's payments." : `Found ${found} dispute${found === 1 ? "" : "s"} on PayPal.`;
  });
}

// Each desk action names the dispute its button was drawn for; the service
// checks that the dispute belongs to the rental.

export async function refreshDisputeAction(rentalId: string, disputeId: string) {
  return asStaff(() => desk.refreshDispute(rentalId, disputeId));
}

export async function prepareEvidenceAction(rentalId: string, disputeId: string) {
  return asStaff(async () => {
    await desk.prepareEvidence(rentalId, disputeId);
  });
}

export async function submitEvidenceAction(rentalId: string, disputeId: string) {
  return asStaff(async () => {
    await desk.submitEvidence(rentalId, disputeId);
  });
}

export async function acceptClaimAction(rentalId: string, disputeId: string) {
  return asStaff(() => desk.acceptClaim(rentalId, disputeId));
}

export async function makeOfferAction(rentalId: string, disputeId: string, cents: number) {
  return asStaff(async () => {
    if (!Number.isSafeInteger(cents)) throw new UserError("Enter the offer in whole cents.");
    await desk.makeOffer(rentalId, cents, disputeId);
  });
}

export async function sandboxRequireEvidenceAction(rentalId: string, disputeId: string) {
  return asStaff(() => desk.sandboxRequireEvidence(rentalId, disputeId));
}

export async function sandboxDecideAction(rentalId: string, disputeId: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR") {
  return asStaff(async () => {
    if (outcome !== "SELLER_FAVOR" && outcome !== "BUYER_FAVOR") throw new UserError("Unknown outcome.");
    await desk.sandboxDecide(rentalId, outcome, disputeId);
  });
}

export async function demoOpenDisputeAction(rentalId: string) {
  return asStaff(() => desk.demoOpenDispute(rentalId));
}
