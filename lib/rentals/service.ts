import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { catalogItem } from "@/lib/catalog";
import { rentalDays, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { inspectReturn } from "@/lib/inspection/run";
import { publish } from "@/lib/live";
import { formatUsd } from "@/lib/money";
import { depositGateway, PayPalError } from "@/lib/paypal";
import { loadPhoto, storePhoto } from "@/lib/photos";
import { afterSettlement } from "@/lib/schedule/agent";
import { assignUnitForBooking, confirmUnitBeforePayment } from "@/lib/schedule/assign";
import { appUrl, SHOP } from "@/lib/shop";
import { appendEvent } from "./audit";
import { inspectionsFor, latestAssessment, rentalById, rentalByOrder, rentalByToken, updateRental } from "./repo";
import { awaitingCustomer, awaitingResolution, planSettlement } from "./settlement";
import { UserError, type Phase, type Rental, type ReviewedFinding } from "./types";

const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newRentalId = () => `R-${[...randomBytes(6)].map((b) => ID_ALPHABET[b % 32]).join("")}`;
const newToken = () => randomBytes(18).toString("base64url");

/**
 * Runs one PayPal step. A PayPal failure is written to the audit log with its
 * debug_id and turned into a message staff or customers can act on.
 */
async function paypalStep<T>(rentalId: string, step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    const db = await getDb();
    await appendEvent(db, rentalId, "paypal", "paypal.error", { step, status: err.status, name: err.errorName, issue: err.issue ?? null, debugId: err.debugId ?? null });
    publish(rentalId, "paypal.error");
    throw new UserError(friendlyPayPalMessage(step, err));
  }
}

function friendlyPayPalMessage(step: string, err: PayPalError): string {
  const ref = err.debugId ? ` (PayPal reference ${err.debugId})` : "";
  switch (err.issue) {
    case "INSTRUMENT_DECLINED":
      return `PayPal declined the payment method. Ask the customer to choose another one in PayPal${ref}.`;
    case "PAYER_ACTION_REQUIRED":
      return `The customer still needs to approve this in PayPal${ref}.`;
    case "MAX_CAPTURE_AMOUNT_EXCEEDED":
      return `That is more than the deposit PayPal is holding${ref}.`;
    case "AUTHORIZATION_EXPIRED":
      return `The deposit hold has expired. Place a new hold before settling${ref}.`;
    case "REAUTHORIZATION_TOO_SOON":
      return `A hold can only be renewed from day 4 of the rental${ref}.`;
    default:
      if (err.retryable) return `PayPal is not answering right now. Try again in a moment; nothing was charged twice${ref}.`;
      return `PayPal could not complete "${step}": ${err.message}${ref}`;
  }
}

async function mustRental(id: string): Promise<Rental> {
  const rental = await rentalById(await getDb(), id);
  if (!rental) throw new UserError("That rental does not exist.");
  return rental;
}

function expectStatus(rental: Rental, allowed: Rental["status"][], action: string) {
  if (!allowed.includes(rental.status)) {
    throw new UserError(`Can't ${action} while the rental is ${rental.status.replace("_", " ")}.`);
  }
}

// ─── Booking ────────────────────────────────────────────────

export const BookingInput = z.object({
  itemId: z.string(),
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().email("Enter a valid email"),
  startDate: z.string(),
  endDate: z.string(),
});

/** Creates the rental and the PayPal order for the fee. Amounts are computed here, never taken from the browser. */
export async function startBooking(raw: z.input<typeof BookingInput>): Promise<{ rentalId: string; orderId: string }> {
  const parsed = BookingInput.safeParse(raw);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the booking details.");
  const input = parsed.data;
  const item = catalogItem(input.itemId);
  if (input.startDate < todayIso()) throw new UserError("Pick a pickup date from today on.");
  let days: number;
  try {
    days = rentalDays(input.startDate, input.endDate);
  } catch {
    throw new UserError("The return date must be after the pickup date.");
  }
  if (days > SHOP.maxRentalDays) throw new UserError(`Rentals can be at most ${SHOP.maxRentalDays} days.`);

  const db = await getDb();
  const id = newRentalId();
  const token = newToken();
  const feeCents = item.dailyCents * days;
  await db.query(
    `insert into rentals (id, token, item_id, customer_name, customer_email, start_date, end_date, days, fee_cents, deposit_cents, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')`,
    [id, token, item.id, input.name, input.email, input.startDate, input.endDate, days, feeCents, item.depositCents],
  );
  await assignUnitForBooking(id);
  const order = await paypalStep(id, "create the booking order", () =>
    depositGateway().createBookingOrder(
      {
        rentalId: id,
        itemName: item.name,
        rentalDays: days,
        feeCents,
        depositCents: item.depositCents,
        shopName: SHOP.name,
        returnUrl: `${appUrl()}/r/${token}`,
        cancelUrl: `${appUrl()}/rent/${item.id}`,
      },
      `booking:${id}`,
    ),
  );
  await db.tx(async (tx) => {
    await updateRental(tx, id, { booking_order_id: order.orderId });
    await appendEvent(tx, id, "customer", "booking.started", { orderId: order.orderId, feeCents, depositCents: item.depositCents, days });
  });
  return { rentalId: id, orderId: order.orderId };
}

/** After the buyer approves in PayPal: capture the fee and keep the saved-wallet token. Safe to call twice. */
export async function confirmBooking(orderId: string): Promise<{ token: string }> {
  const db = await getDb();
  const rental = await rentalByOrder(db, orderId);
  if (!rental) throw new UserError("We couldn't find this booking.");
  if (rental.status !== "draft") return { token: rental.token };

  await confirmUnitBeforePayment(rental.id);
  const paid = await paypalStep(rental.id, "capture the rental fee", () =>
    depositGateway().captureBookingOrder(orderId, `booking-capture:${rental.id}`),
  );
  if (paid.status !== "COMPLETED") {
    throw new UserError("PayPal has not completed the payment yet. Check back in a few minutes.");
  }
  await db.tx(async (tx) => {
    await updateRental(tx, rental.id, {
      status: "booked",
      fee_capture_id: paid.captureId,
      vault_id: paid.vaultId ?? null,
      payer_email: paid.payerEmail ?? null,
    });
    await appendEvent(tx, rental.id, "paypal", "booking.paid", {
      captureId: paid.captureId,
      feeCents: paid.capturedCents,
      savedWallet: Boolean(paid.vaultId),
    });
  });
  publish(rental.id, "booking.paid");
  return { token: rental.token };
}

// ─── Photos ─────────────────────────────────────────────────

const SAMPLE_KEY = /^[a-z0-9-]+\/[a-z0-9_-]+$/;

export async function samplePhotoBytes(sample: string): Promise<Buffer> {
  const file = path.join(process.cwd(), "eval", "images", `${sample}.jpg`);
  if (!SAMPLE_KEY.test(sample) || !existsSync(file)) throw new UserError("That sample photo does not exist.");
  return readFile(file);
}

export async function addPhoto(rentalId: string, phase: Phase, source: { bytes: Buffer } | { sample: string }) {
  const rental = await mustRental(rentalId);
  expectStatus(rental, phase === "checkout" ? ["booked"] : ["out"], phase === "checkout" ? "add a pickup photo" : "add a return photo");
  const sample = "sample" in source ? source.sample : null;
  const bytes = "bytes" in source ? source.bytes : await samplePhotoBytes(source.sample);
  const photo = await storePhoto(bytes);
  if (photo.quality.problems.length) throw new UserError(photo.quality.problems.join(" "));

  const db = await getDb();
  await db.tx(async (tx) => {
    await tx.query("insert into inspections (id, rental_id, phase, photo_sha, quality, sample) values ($1, $2, $3, $4, $5::jsonb, $6)", [
      randomUUID(),
      rentalId,
      phase,
      photo.sha256,
      JSON.stringify(photo.quality),
      sample,
    ]);
    await appendEvent(tx, rentalId, "staff", "photo.added", { phase, sha256: photo.sha256, sample, sharpness: photo.quality.sharpness });
  });
  publish(rentalId, "photo.added");
  return photo;
}

// ─── Pickup ─────────────────────────────────────────────────

/** Holds the deposit on the customer's saved PayPal wallet: the 29-day clock starts now, at pickup. */
export async function holdDeposit(rentalId: string): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["booked"], "hold the deposit");
  if (!rental.vaultId) throw new UserError("This customer did not save PayPal at booking, so the deposit needs their approval.");
  const db = await getDb();
  const photos = (await inspectionsFor(db, rentalId)).filter((i) => i.phase === "checkout");
  if (photos.length === 0) throw new UserError("Take the pickup photo first, so the condition is on record before the item leaves.");
  const item = catalogItem(rental.itemId);

  const auth = await paypalStep(rentalId, "hold the deposit", () =>
    depositGateway().holdWithSavedWallet(
      { vaultId: rental.vaultId!, rentalId, amountCents: rental.depositCents, description: `Refundable deposit: ${item.name}` },
      `deposit:${rentalId}`,
    ),
  );
  await db.tx(async (tx) => {
    await updateRental(tx, rentalId, {
      status: "out",
      authorization_id: auth.authorizationId,
      authorized_cents: auth.amountCents,
      authorized_at: auth.createdAt,
      authorization_expires_at: auth.expiresAt ?? null,
    });
    await appendEvent(tx, rentalId, "paypal", "deposit.held", {
      authorizationId: auth.authorizationId,
      amountCents: auth.amountCents,
      expiresAt: auth.expiresAt ?? null,
    });
  });
  publish(rentalId, "deposit.held");
}

/** The customer confirms, on their own phone, that the pickup photos show the item as they received it. */
export async function acknowledgeCheckout(token: string): Promise<void> {
  const db = await getDb();
  const rental = await rentalByToken(db, token);
  if (!rental) throw new UserError("This link is not valid.");
  expectStatus(rental, ["booked", "out"], "confirm the pickup photos");
  const photos = (await inspectionsFor(db, rental.id)).filter((i) => i.phase === "checkout" && !i.acknowledgedAt);
  if (photos.length === 0) return;
  await db.tx(async (tx) => {
    await tx.query("update inspections set acknowledged_at = now() where rental_id = $1 and phase = 'checkout' and acknowledged_at is null", [rental.id]);
    await appendEvent(tx, rental.id, "customer", "checkout.acknowledged", { photoHashes: photos.map((p) => p.photoSha) });
  });
  publish(rental.id, "checkout.acknowledged");
}

// ─── Return ─────────────────────────────────────────────────

/** Compares the latest pickup and return photos with two independent looks. */
export async function inspect(rentalId: string): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["out"], "inspect the return");
  const db = await getDb();
  const all = await inspectionsFor(db, rentalId);
  const checkout = all.filter((i) => i.phase === "checkout").at(-1);
  const checkin = all.filter((i) => i.phase === "checkin").at(-1);
  if (!checkout || !checkin) throw new UserError("Both a pickup photo and a return photo are needed.");
  const [before, after] = await Promise.all([loadPhoto(checkout.photoSha), loadPhoto(checkin.photoSha)]);
  if (!before || !after) throw new UserError("A photo is missing from storage.");

  const item = catalogItem(rental.itemId);
  const run = await inspectReturn({ bytes: before.bytes, sample: checkout.sample }, { bytes: after.bytes, sample: checkin.sample }, item, SHOP.name);
  const findings: ReviewedFinding[] = run.assessment.findings.map((f) => ({
    ...f,
    staff: f.decision === "note" ? "waive" : "keep",
    customer: null,
    customerNote: null,
    resolution: null,
  }));
  const charges = findings.filter((f) => f.staff === "keep").length;

  await db.tx(async (tx) => {
    await tx.query(
      `insert into assessments (id, rental_id, checkout_sha, checkin_sha, model, source, usable, issue, summary, looks, findings, proposed_cents, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, 'staff_review')`,
      [
        randomUUID(),
        rentalId,
        checkout.photoSha,
        checkin.photoSha,
        run.model,
        run.source,
        run.assessment.usable,
        run.assessment.issue,
        run.assessment.summary,
        JSON.stringify(run.looks),
        JSON.stringify(findings),
        run.assessment.proposedCents,
      ],
    );
    await updateRental(tx, rentalId, { status: "inspecting" });
    await appendEvent(tx, rentalId, "ai", "inspection.completed", {
      source: run.source,
      model: run.model,
      ms: run.ms,
      looks: run.looks.length,
      proposedCharges: charges,
      notes: findings.length - charges,
      proposedCents: run.assessment.proposedCents,
      checkoutSha: checkout.photoSha,
      checkinSha: checkin.photoSha,
    });
  });
  publish(rentalId, "inspection.completed");
}

async function mustAssessment(rentalId: string) {
  const assessment = await latestAssessment(await getDb(), rentalId);
  if (!assessment) throw new UserError("Inspect the return first.");
  return assessment;
}

async function saveFindings(assessmentId: string, findings: ReviewedFinding[]) {
  const db = await getDb();
  await db.query("update assessments set findings = $2::jsonb where id = $1", [assessmentId, JSON.stringify(findings)]);
}

/** Staff keep or waive a proposed charge before the customer sees it. */
export async function setStaffDecision(rentalId: string, findingId: string, staff: "keep" | "waive"): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["inspecting"], "change a finding");
  const assessment = await mustAssessment(rentalId);
  const findings = assessment.findings.map((f) => (f.id === findingId && f.decision !== "note" && f.price ? { ...f, staff } : f));
  await saveFindings(assessment.id, findings);
  await appendEvent(await getDb(), rentalId, "staff", staff === "keep" ? "finding.kept" : "finding.waived", { findingId });
  publish(rentalId, "finding.changed");
}

/** Shows the kept findings to the customer on their phone. Nothing is charged until they answer. */
export async function sendToCustomer(rentalId: string): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["inspecting"], "send the findings");
  const assessment = await mustAssessment(rentalId);
  const pending = awaitingCustomer(assessment.findings);
  if (pending.length === 0) throw new UserError("Nothing to charge, so there is nothing to send. Release the deposit instead.");
  const db = await getDb();
  await db.tx(async (tx) => {
    await tx.query("update assessments set status = 'customer_review', sent_at = now() where id = $1", [assessment.id]);
    await updateRental(tx, rentalId, { status: "customer_review" });
    await appendEvent(tx, rentalId, "staff", "review.sent", { findings: pending.map((f) => f.id), proposedCents: pending.reduce((s, f) => s + (f.price?.cents ?? 0), 0) });
  });
  publish(rentalId, "review.sent");
}

export const CustomerAnswers = z.array(
  z.object({ findingId: z.string(), answer: z.enum(["accept", "contest"]), note: z.string().trim().max(500).optional() }),
);

/** The renter accepts or contests each proposed charge on their own phone. */
export async function respondAsCustomer(token: string, raw: z.input<typeof CustomerAnswers>): Promise<void> {
  const answers = CustomerAnswers.parse(raw);
  const db = await getDb();
  const rental = await rentalByToken(db, token);
  if (!rental) throw new UserError("This link is not valid.");
  expectStatus(rental, ["customer_review"], "answer the findings");
  const assessment = await mustAssessment(rental.id);
  const pending = awaitingCustomer(assessment.findings);
  const byId = new Map(answers.map((a) => [a.findingId, a]));
  if (pending.some((f) => !byId.has(f.id))) throw new UserError("Please accept or question every item.");
  for (const a of answers) {
    if (a.answer === "contest" && !a.note) throw new UserError("Tell the shop briefly why you question an item.");
  }
  const findings = assessment.findings.map((f) => {
    const a = byId.get(f.id);
    return a && pending.includes(f) ? { ...f, customer: a.answer, customerNote: a.note ?? null } : f;
  });
  const contested = findings.filter((f) => f.customer === "contest").length;
  await db.tx(async (tx) => {
    await tx.query("update assessments set findings = $2::jsonb, status = 'responded', responded_at = now() where id = $1", [assessment.id, JSON.stringify(findings)]);
    await updateRental(tx, rental.id, { status: "responded" });
    await appendEvent(tx, rental.id, "customer", "customer.responded", { accepted: answers.length - contested, contested });
  });
  publish(rental.id, "customer.responded");
}

/** The counter's final word on a contested item. */
export async function resolveContest(rentalId: string, findingId: string, resolution: "charge" | "waive"): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["responded"], "resolve a question");
  const assessment = await mustAssessment(rentalId);
  const findings = assessment.findings.map((f) => (f.id === findingId && f.customer === "contest" ? { ...f, resolution } : f));
  await saveFindings(assessment.id, findings);
  await appendEvent(await getDb(), rentalId, "staff", resolution === "charge" ? "contest.upheld" : "contest.waived", { findingId });
  publish(rentalId, "contest.resolved");
}

/**
 * Moves the money. With nothing owed the hold is voided; otherwise one final
 * capture takes exactly the agreed charges and PayPal releases the rest. Any
 * part above the deposit goes to the saved wallet. Request ids are derived
 * from the rental, so a double tap cannot charge twice.
 */
export async function settle(rentalId: string): Promise<void> {
  const rental = await mustRental(rentalId);
  expectStatus(rental, ["inspecting", "responded"], "settle");
  if (!rental.authorizationId || !rental.authorizedCents) throw new UserError("No deposit is being held for this rental.");
  const assessment = await mustAssessment(rentalId);
  if (rental.status === "inspecting" && awaitingCustomer(assessment.findings).length > 0) {
    throw new UserError("Send the findings to the customer first, or waive them.");
  }
  if (awaitingResolution(assessment.findings).length > 0) throw new UserError("Decide on every questioned item first.");

  const plan = planSettlement(assessment.findings, rental.authorizedCents, Boolean(rental.vaultId));
  const gateway = depositGateway();
  let captureId: string | null = null;
  if (plan.captureCents === 0) {
    await paypalStep(rentalId, "release the deposit", () => gateway.release(rental.authorizationId!, `release:${rentalId}`));
  } else {
    const settled = await paypalStep(rentalId, "settle the deposit", () =>
      gateway.settle(
        {
          authorizationId: rental.authorizationId!,
          amountCents: plan.captureCents,
          authorizedCents: rental.authorizedCents!,
          invoiceId: `${rentalId}-damage`,
          noteToPayer: plan.lines.map((l) => `${l.label} ${formatUsd(l.cents)}`).join("; "),
        },
        `settle:${rentalId}`,
      ),
    );
    captureId = settled.captureId;
  }
  let extraCaptureId: string | null = null;
  if (plan.extraCents > 0 && rental.vaultId) {
    const extra = await paypalStep(rentalId, "charge the amount above the deposit", () =>
      gateway.chargeSavedWallet(
        { vaultId: rental.vaultId!, rentalId, amountCents: plan.extraCents, description: "Repairs above the deposit" },
        `extra:${rentalId}`,
      ),
    );
    extraCaptureId = extra.captureId;
  }

  const db = await getDb();
  await db.tx(async (tx) => {
    await updateRental(tx, rentalId, {
      status: "settled",
      settlement_capture_id: captureId,
      captured_cents: plan.captureCents,
      released_cents: plan.releasedCents,
      extra_capture_id: extraCaptureId,
      extra_cents: plan.extraCents,
      settled_at: new Date().toISOString(),
    });
    await tx.query("update assessments set status = 'final' where id = $1", [assessment.id]);
    await appendEvent(tx, rentalId, "paypal", plan.captureCents === 0 ? "deposit.released" : "deposit.settled", {
      captureId,
      capturedCents: plan.captureCents,
      releasedCents: plan.releasedCents,
      extraCents: plan.extraCents,
      uncollectedCents: plan.uncollectedCents,
      lines: plan.lines,
    });
  });
  publish(rentalId, "deposit.settled");
  await afterSettlement(rentalId);
}
