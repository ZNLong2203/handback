import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CATALOG, catalogItem, type RentalItem } from "@/lib/catalog";
import { isIsoDay, rentalDays, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { inspectReturn } from "@/lib/inspection/run";
import { publish } from "@/lib/live";
import { formatUsd, type Cents } from "@/lib/money";
import { depositGateway, PayPalError } from "@/lib/paypal";
import { loadPhoto, storePhoto } from "@/lib/photos";
import { appUrl, SHOP } from "@/lib/shop";
import { appendEvent, firstBrokenLink } from "./audit";
import { buildMandate, mandateViolations, openMandate, sealMandate, type DepositMandate, type MandatedCharge, type MandateIssuer } from "./mandate";
import { eventsFor, inspectionsFor, latestAssessment, rentalById, rentalByOrder, rentalByToken, updateRental } from "./repo";
import { awaitingCustomer, awaitingResolution, isCharged, planSettlement } from "./settlement";
import { UserError, type AuditEvent, type Phase, type Rental, type ReviewedFinding } from "./types";

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
    if (!PayPalError.is(err)) throw err;
    const db = await getDb();
    const refusal = { step, status: err.status, name: err.errorName, issue: err.issue ?? null, debugId: err.debugId ?? null, message: err.message };
    await appendEvent(db, rentalId, "paypal", "paypal.error", refusal);
    publish(rentalId, "paypal.error");
    throw new UserError(explainPayPalError(refusal));
  }
}

type PayPalRefusal = { step: string; status: number; issue: string | null; debugId: string | null; message: string };

/** A PayPal failure in words staff or customers can act on; also rebuilds one from its audit entry. */
function explainPayPalError(err: PayPalRefusal): string {
  const ref = err.debugId ? ` (PayPal reference ${err.debugId})` : "";
  switch (err.issue) {
    case "INSTRUMENT_DECLINED":
      return `PayPal declined the payment method. Ask the customer to choose another one in PayPal${ref}.`;
    case "PAYER_ACTION_REQUIRED":
      return `The customer still needs to approve this in PayPal${ref}.`;
    case "ORDER_NOT_APPROVED":
      return `PayPal has no approval for this payment yet, so nothing was charged. Approve it in PayPal first${ref}.`;
    case "MAX_CAPTURE_AMOUNT_EXCEEDED":
      return `That is more than the deposit PayPal is holding${ref}.`;
    case "AUTHORIZATION_EXPIRED":
      return `The deposit hold has expired. Place a new hold before settling${ref}.`;
    case "REAUTHORIZATION_TOO_SOON":
      return `A hold can only be renewed from day 4 of the rental${ref}.`;
    default:
      if (err.status === 429 || err.status >= 500) return `PayPal is not answering right now. Try again in a moment; nothing was charged twice${ref}.`;
      return `PayPal could not complete "${err.step}": ${err.message}${ref}`;
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

/**
 * The deterministic check in front of every hold and charge: what the shop is
 * about to do must fit the deposit mandate the renter approved. The stored
 * mandate must hash to the value the audit chain recorded when the booking
 * started, and the chain itself must still be intact, so re-sealing, swapping
 * or clearing the mandate after the fact stops the money instead of changing
 * the terms; so does editing the recorded hash short of rewriting every entry
 * after it. A refusal is written to the audit log. Rentals booked before
 * mandates existed have neither and are not checked.
 */
async function assertWithinMandate(rental: Rental, step: string, act: { holdCents?: Cents; charges?: MandatedCharge[] }) {
  const db = await getDb();
  const events = await eventsFor(db, rental.id);
  const issued = events.find((e) => e.type === "mandate.issued");
  const recorded = typeof issued?.data.sha256 === "string" ? issued.data.sha256 : null;
  if (!recorded && !rental.mandateJson && !rental.mandateSha256) return;
  const opened = rental.mandateJson && rental.mandateSha256 ? openMandate(rental.mandateJson, rental.mandateSha256) : null;
  const broken = firstBrokenLink(events);
  const problems =
    broken !== null
      ? [`The rental's audit log was changed after the fact (entry ${broken} no longer matches), so the mandate it recorded cannot be trusted.`]
      : opened?.intact && rental.mandateSha256 === recorded && opened.mandate.rentalId === rental.id
        ? mandateViolations(opened.mandate, { at: new Date(), ...act })
        : ["The stored mandate is not the one recorded when the booking started, so nothing can be held or charged under it."];
  if (problems.length === 0) return;
  await appendEvent(db, rental.id, "system", "mandate.refused", { step, problems });
  publish(rental.id, "mandate.refused");
  throw new UserError(`Outside the renter's deposit mandate: ${problems.join(" ")}`);
}

// ─── Booking ────────────────────────────────────────────────

/** The renter's private page. PayPal sends them back here after approving or cancelling. */
export const rentalPageUrl = (token: string) => `${appUrl()}/r/${token}`;

export type Quote = { item: RentalItem; startDate: string; endDate: string; days: number; feeCents: Cents; depositCents: Cents };

/** Prices a rental. Amounts are computed here, never taken from the browser or an assistant. */
export function quoteRental(input: { itemId: string; startDate: string; endDate: string }, today = todayIso()): Quote {
  const item = CATALOG.find((i) => i.id === input.itemId);
  if (!item) throw new UserError(`There is no rental item "${input.itemId}".`);
  if (!isIsoDay(input.startDate) || !isIsoDay(input.endDate)) throw new UserError("Give the dates as real days, YYYY-MM-DD.");
  if (input.startDate < today) throw new UserError("Pick a pickup date from today on.");
  let days: number;
  try {
    days = rentalDays(input.startDate, input.endDate);
  } catch {
    throw new UserError("The return date must be after the pickup date.");
  }
  if (days > SHOP.maxRentalDays) throw new UserError(`Rentals can be at most ${SHOP.maxRentalDays} days.`);
  return { item, startDate: input.startDate, endDate: input.endDate, days, feeCents: item.dailyCents * days, depositCents: item.depositCents };
}

export const BookingInput = z.object({
  itemId: z.string(),
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().email("Enter a valid email"),
  startDate: z.string(),
  endDate: z.string(),
});

export type StartedBooking = {
  rentalId: string;
  token: string;
  orderId: string;
  /** PayPal's payer-action link, for approving by redirect instead of the in-page button. */
  approveUrl: string | null;
  mandate: DepositMandate;
  mandateSha256: string;
};

/**
 * Creates the rental, its deposit mandate and the PayPal order for the fee.
 * Nothing is charged here: the renter approves the order in PayPal, and only
 * then does confirmBooking capture it. `issuer` records who the mandate was
 * handed to: the renter on the website, or an assistant acting for them.
 */
export async function startBooking(raw: z.input<typeof BookingInput>, issuer: MandateIssuer = { party: "renter" }): Promise<StartedBooking> {
  const parsed = BookingInput.safeParse(raw);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the booking details.");
  const input = parsed.data;
  const { item, days, feeCents } = quoteRental(input);

  const db = await getDb();
  const id = newRentalId();
  const token = newToken();
  const mandate = buildMandate({
    rentalId: id,
    item,
    shop: SHOP,
    renter: { name: input.name, email: input.email },
    issuer,
    pickup: input.startDate,
    returnDate: input.endDate,
    days,
    feeCents,
    createdAt: new Date(),
  });
  const sealed = sealMandate(mandate);
  await db.tx(async (tx) => {
    await tx.query(
      `insert into rentals (id, token, item_id, customer_name, customer_email, start_date, end_date, days, fee_cents, deposit_cents, status, mandate_json, mandate_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12)`,
      [id, token, item.id, input.name, input.email, input.startDate, input.endDate, days, feeCents, item.depositCents, sealed.json, sealed.sha256],
    );
    await appendEvent(tx, id, "system", "mandate.issued", {
      sha256: sealed.sha256,
      issuedTo: issuer.party,
      assistant: issuer.party === "assistant" ? issuer.assistant : null,
      maxHoldCents: mandate.hold.maxCents,
      expiresAt: mandate.expiresAt,
    });
  });
  const order = await paypalStep(id, "create the booking order", () =>
    depositGateway().createBookingOrder(
      {
        rentalId: id,
        itemName: item.name,
        rentalDays: days,
        feeCents,
        depositCents: item.depositCents,
        shopName: SHOP.name,
        returnUrl: rentalPageUrl(token),
        cancelUrl: `${rentalPageUrl(token)}?paypal=cancelled`,
      },
      `booking:${id}`,
    ),
  );
  const approveUrl = order.approveUrl ?? null;
  await db.tx(async (tx) => {
    await updateRental(tx, id, { booking_order_id: order.orderId, approve_url: approveUrl });
    await appendEvent(tx, id, issuer.party === "assistant" ? "assistant" : "customer", "booking.started", {
      orderId: order.orderId,
      feeCents,
      depositCents: item.depositCents,
      days,
    });
  });
  return { rentalId: id, token, orderId: order.orderId, approveUrl, mandate, mandateSha256: sealed.sha256 };
}

/** After the buyer approves in PayPal: capture the fee and keep the saved-wallet token. Safe to call twice, even at once. */
export async function confirmBooking(orderId: string): Promise<{ token: string }> {
  const db = await getDb();
  const rental = await rentalByOrder(db, orderId);
  if (!rental) throw new UserError("We couldn't find this booking.");
  if (rental.status !== "draft") return { token: rental.token };

  const paid = await paypalStep(rental.id, "capture the rental fee", () =>
    depositGateway().captureBookingOrder(orderId, `booking-capture:${rental.id}`),
  );
  if (paid.status !== "COMPLETED") {
    throw new UserError("PayPal has not completed the payment yet. Check back in a few minutes.");
  }
  const booked = await db.tx(async (tx) => {
    const moved = await updateRental(
      tx,
      rental.id,
      { status: "booked", fee_capture_id: paid.captureId, vault_id: paid.vaultId ?? null, payer_email: paid.payerEmail ?? null },
      "draft",
    );
    if (moved) {
      await appendEvent(tx, rental.id, "paypal", "booking.paid", {
        captureId: paid.captureId,
        feeCents: paid.capturedCents,
        savedWallet: Boolean(paid.vaultId),
      });
    }
    return moved;
  });
  if (booked) publish(rental.id, "booking.paid");
  return { token: rental.token };
}

export type PayPalReturn = "none" | "approved" | "cancelled" | "failed";

/**
 * PayPal sends the renter back to their page after the approval step: with
 * ?token=<order id>&PayerID=… when they approved, or with ?paypal=cancelled
 * when they left. An approval is captured here, on the server, exactly as
 * the in-page button does; a reload of the same URL changes nothing.
 */
export async function returnFromPayPal(rentalToken: string, query: { token?: string; PayerID?: string; paypal?: string }): Promise<PayPalReturn> {
  const rental = await rentalByToken(await getDb(), rentalToken);
  if (!rental) return "none";
  if (query.paypal === "cancelled") return rental.status === "draft" ? "cancelled" : "none";
  if (!query.token || !query.PayerID || query.token !== rental.bookingOrderId) return "none";
  if (rental.status !== "draft") return "approved";
  try {
    await confirmBooking(query.token);
    return "approved";
  } catch (err) {
    if (err instanceof UserError) return "failed";
    throw err;
  }
}

/**
 * Why the last attempt to capture the booking failed, from the audit log, so
 * the page can explain it after moving to a URL that does not retry it. Null
 * when PayPal did not refuse (a capture still pending).
 */
export function captureRefusal(events: AuditEvent[]): string | null {
  const last = events.findLast((e) => e.type === "paypal.error" && e.data.step === "capture the rental fee");
  if (!last) return null;
  const d = last.data as Partial<PayPalRefusal>;
  return explainPayPalError({
    step: "capture the rental fee",
    status: Number(d.status ?? 0),
    issue: d.issue ?? null,
    debugId: d.debugId ?? null,
    message: d.message ?? "PayPal refused the payment",
  });
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
  await assertWithinMandate(rental, "hold the deposit", { holdCents: rental.depositCents });

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
  // Releasing is always allowed; every charge must fit the renter's mandate.
  const charged = assessment.findings.filter(isCharged);
  if (charged.length > 0) {
    await assertWithinMandate(rental, "settle the deposit", {
      charges: charged.map((f) => ({ priceId: f.price!.id, label: f.price!.label, cents: f.price!.cents, shownToRenter: f.customer !== null })),
    });
  }
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
}
