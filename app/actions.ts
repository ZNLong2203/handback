"use server";

import { refresh } from "next/cache";
import * as desk from "@/lib/disputes/service";
import { after } from "next/server";
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
