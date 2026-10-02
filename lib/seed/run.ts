import "server-only";
import { catalogItem } from "@/lib/catalog";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { depositGateway, PayPalError } from "@/lib/paypal";
import type { PayPalMode } from "@/lib/paypal/config";
import { appendEvent } from "@/lib/rentals/audit";
import { inspectionsFor, latestAssessment, rentalById, updateRental } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import { UserError, type Rental, type RentalStatus } from "@/lib/rentals/types";
import { samplesFor } from "@/lib/samples";
import { runInspection } from "@/lib/workflows/dispatch";
import { nextSeedStep, SCENARIOS, type SeedScenario, type SeedState, type SeedStep } from "./plan";

export type SeedLine = {
  scenario: SeedScenario;
  rentalId: string | null;
  status: RentalStatus | null;
  ran: SeedStep[];
  /** Why the rental stopped short of its target, when it did. */
  stopped?: string;
};

export type SeedReport = { mode: PayPalMode; skipped?: string; lines: SeedLine[] };

/**
 * Walks each scenario's rental to its target through the real rental
 * service. In demo mode the PayPal stand-in plays the customer. In sandbox
 * mode every payment is a real sandbox payment, and since a script cannot
 * approve a PayPal checkout, bookings are paid with a wallet a customer
 * saved at an earlier sandbox booking (`vaultId`); without one nothing is
 * created. Live PayPal is refused outright.
 */
export async function seedCounter(opts: { vaultId?: string } = {}): Promise<SeedReport> {
  const mode = depositGateway().mode;
  if (mode === "live") {
    return { mode, skipped: "PayPal is live. The seed moves money, so it only runs against the sandbox or the demo stand-in.", lines: [] };
  }
  if (mode === "sandbox" && !opts.vaultId) {
    return {
      mode,
      skipped:
        "PayPal is in sandbox mode and SEED_VAULT_ID is not set. Every seeded rental starts with a paid booking, and a script cannot approve a PayPal checkout, so the fee and the deposit hold need a wallet a customer saved at an earlier sandbox booking (the rentals.vault_id of a booking you paid through the PayPal button). Nothing was created.",
      lines: [],
    };
  }
  const lines: SeedLine[] = [];
  for (const scenario of SCENARIOS) lines.push(await converge(scenario, opts.vaultId));
  return { mode, lines };
}

/** The wallet saved at the most recent booking paid through the PayPal button, for SEED_VAULT_ID=latest. */
export async function latestSavedWallet(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<{ vault_id: string }>(
    "select vault_id from rentals where vault_id is not null and status <> 'draft' order by created_at desc limit 1",
  );
  return rows[0]?.vault_id ?? null;
}

async function findRental(email: string): Promise<Rental | null> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>("select id from rentals where customer_email = $1 order by created_at desc limit 1", [email]);
  return rows[0] ? rentalById(db, rows[0].id) : null;
}

async function stateOf(rental: Rental | null): Promise<SeedState> {
  if (!rental) return { status: null, pickupPhoto: false, acknowledged: false, returnPhoto: false, awaitingCustomer: 0 };
  const db = await getDb();
  const photos = await inspectionsFor(db, rental.id);
  const pickup = photos.filter((p) => p.phase === "checkout");
  const assessment = await latestAssessment(db, rental.id);
  return {
    status: rental.status,
    pickupPhoto: pickup.length > 0,
    acknowledged: pickup.length > 0 && pickup.every((p) => p.acknowledgedAt),
    returnPhoto: photos.some((p) => p.phase === "checkin"),
    awaitingCustomer: assessment ? awaitingCustomer(assessment.findings).length : 0,
  };
}

async function converge(scenario: SeedScenario, vaultId: string | undefined): Promise<SeedLine> {
  let rental = await findRental(scenario.email);
  const ran: SeedStep[] = [];
  for (;;) {
    const before = await stateOf(rental);
    const step = nextSeedStep(before, scenario.target);
    const line = { scenario, rentalId: rental?.id ?? null, status: before.status, ran };
    if (!step) return line;
    try {
      rental = await runStep(step, scenario, rental, vaultId);
    } catch (err) {
      if (err instanceof PayPalError) return { ...line, stopped: `${err.message}${err.debugId ? ` (PayPal debug_id ${err.debugId})` : ""}` };
      if (err instanceof UserError) return { ...line, stopped: err.message };
      throw err;
    }
    ran.push(step);
    if (JSON.stringify(await stateOf(rental)) === JSON.stringify(before)) return { ...line, ran, stopped: `"${step}" changed nothing` };
  }
}

async function runStep(step: SeedStep, scenario: SeedScenario, rental: Rental | null, vaultId: string | undefined): Promise<Rental> {
  if (step === "book") {
    const startDate = addDaysIso(todayIso(), scenario.startsInDays);
    const { rentalId } = await svc.startBooking({
      itemId: scenario.itemId,
      name: scenario.name,
      email: scenario.email,
      startDate,
      endDate: addDaysIso(startDate, scenario.days),
    });
    return reload(rentalId);
  }
  const r = rental!;
  switch (step) {
    case "pay":
      if (depositGateway().mode === "demo") await svc.confirmBooking(r.bookingOrderId!);
      else await payWithSavedWallet(r, vaultId!);
      break;
    case "pickup-photo":
      await svc.addPhoto(r.id, "checkout", { sample: samplesFor(r.itemId, "checkout")[0].key });
      break;
    case "hold":
      await svc.holdDeposit(r.id);
      break;
    case "acknowledge":
      await svc.acknowledgeCheckout(r.token);
      break;
    case "return-photo":
      if (!scenario.returnSample) throw new UserError("This scenario has no return photo.");
      await svc.addPhoto(r.id, "checkin", { sample: scenario.returnSample });
      break;
    case "inspect":
      await runInspection(r.id);
      break;
    case "send":
      await svc.sendToCustomer(r.id);
      break;
    case "answer": {
      const assessment = await latestAssessment(await getDb(), r.id);
      const answers = awaitingCustomer(assessment?.findings ?? []).map((f) => ({ findingId: f.id, answer: "accept" as const }));
      await svc.respondAsCustomer(r.token, answers);
      break;
    }
    case "settle":
      await svc.settle(r.id);
      break;
  }
  return reload(r.id);
}

async function reload(rentalId: string): Promise<Rental> {
  const rental = await rentalById(await getDb(), rentalId);
  if (!rental) throw new Error(`rental ${rentalId} disappeared`);
  return rental;
}

/**
 * Sandbox only. The customer would approve the fee in the PayPal popup; the
 * seed charges it to the saved wallet instead: a real sandbox capture, and
 * the audit log says how it was paid. The booking order startBooking created
 * stays unapproved and expires.
 */
async function payWithSavedWallet(rental: Rental, vaultId: string): Promise<void> {
  const item = catalogItem(rental.itemId);
  const paid = await depositGateway().chargeSavedWallet(
    {
      vaultId,
      rentalId: rental.id,
      amountCents: rental.feeCents,
      description: `Rental fee: ${item.name}, ${rental.days} ${rental.days === 1 ? "day" : "days"}`,
      invoiceId: `${rental.id}-fee`,
    },
    `seed-fee:${rental.id}`,
  );
  if (paid.status !== "COMPLETED") throw new UserError(`PayPal left the fee capture ${paid.captureId} ${paid.status}; run the seed again later.`);
  const db = await getDb();
  await db.tx(async (tx) => {
    await updateRental(tx, rental.id, { status: "booked", fee_capture_id: paid.captureId, vault_id: vaultId });
    await appendEvent(tx, rental.id, "paypal", "booking.paid", {
      captureId: paid.captureId,
      feeCents: rental.feeCents,
      savedWallet: true,
      paidWith: "saved wallet (seed script)",
    });
  });
}
