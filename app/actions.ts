"use server";

import { refresh } from "next/cache";
import * as svc from "@/lib/rentals/service";
import { UserError, type Phase } from "@/lib/rentals/types";
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

// ─── Customer ───────────────────────────────────────────────

export async function startBookingAction(input: {
  itemId: string;
  name: string;
  email: string;
  startDate: string;
  endDate: string;
}) {
  return run(() => svc.startBooking(input), false);
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
  return run(async () => {
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
  return run(() => svc.holdDeposit(rentalId));
}

/** Runs on Render Workflows when the deployment is set up for it, in this process otherwise. */
export async function inspectAction(rentalId: string) {
  return run(() => runInspection(rentalId));
}

export async function setStaffDecisionAction(rentalId: string, findingId: string, staff: "keep" | "waive") {
  return run(() => svc.setStaffDecision(rentalId, findingId, staff));
}

export async function sendToCustomerAction(rentalId: string) {
  return run(() => svc.sendToCustomer(rentalId));
}

export async function resolveContestAction(rentalId: string, findingId: string, resolution: "charge" | "waive") {
  return run(() => svc.resolveContest(rentalId, findingId, resolution));
}

export async function settleAction(rentalId: string) {
  return run(() => svc.settle(rentalId));
}
