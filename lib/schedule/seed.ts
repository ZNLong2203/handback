import "server-only";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { depositGateway } from "@/lib/paypal";
import { paypalConfig } from "@/lib/paypal/config";
import { latestAssessment, rentalById } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import type { SeedScenario } from "@/lib/seed/plan";
import { convergeScenario, type SeedReport } from "@/lib/seed/run";
import { freeUnitFor } from "./place";

// Two weeks of bookings for demo mode, so the schedule has something to show
// the first time it opens. Every rental goes through the same service calls a
// real one does (booking, PayPal stand-in, photos, inspection, settlement);
// the only shortcut is moving a few of them back in time afterwards, because
// a real booking can never start in the past. A deployment on the PayPal
// sandbox books a version of it with real sandbox payments instead (below).

export type SeedPlan = {
  name: string;
  itemId: string;
  /** Pickup and return as days from today; both ends included. */
  from: number;
  to: number;
  /** How far the story has got by today. */
  state: "booked" | "out" | "inspecting" | "responded" | "settled";
  /** The return photo, for rentals that are back. */
  checkin?: string;
  /** The unit it should land on, given the order below; the seed test checks it. */
  unit: string;
};

const SCENE: Record<string, string> = { ebike: "ebike-rear" };

/**
 * Rentals already under way come first, then bookings by pickup date. Each
 * booking takes the first free unit, so this order decides the layout. The
 * projector rows carry the demo: Jordan's projector comes back today with a
 * cracked lens, and Priya's and Diego's bookings on the same unit then need
 * a fix.
 */
export const SEED_PLAN: SeedPlan[] = [
  { name: "Jordan Lee", itemId: "projector", from: -3, to: 0, state: "out", unit: "projector-a" },
  { name: "Alex Kim", itemId: "drone-kit", from: -2, to: 1, state: "out", unit: "drone-kit-a" },
  { name: "Grace Liu", itemId: "camera-kit", from: -1, to: 2, state: "out", unit: "camera-kit-a" },
  { name: "Liam Walsh", itemId: "ebike", from: -1, to: 3, state: "out", unit: "ebike-a" },
  { name: "Linh Tran", itemId: "city-bike", from: -1, to: 1, state: "out", unit: "city-bike-a" },
  { name: "Lena Fischer", itemId: "camera-kit", from: -6, to: -3, state: "settled", checkin: "after__same-light", unit: "camera-kit-b" },
  { name: "Nora Bennett", itemId: "action-cam-kit", from: -4, to: -1, state: "settled", checkin: "after__same-pose", unit: "action-cam-kit-a" },
  { name: "Ben Okafor", itemId: "pa-speaker", from: -5, to: -2, state: "settled", checkin: "after__grille-dent", unit: "pa-speaker-a" },
  { name: "Ravi Shah", itemId: "tele-lens", from: -4, to: -1, state: "responded", checkin: "after__dent", unit: "tele-lens-a" },
  { name: "Sofia Marino", itemId: "camera-body", from: -3, to: 0, state: "inspecting", checkin: "after__top-scratch", unit: "camera-body-a" },
  { name: "Kai Tanaka", itemId: "drone-kit", from: 1, to: 2, state: "booked", unit: "drone-kit-b" },
  { name: "Leo Garcia", itemId: "action-cam-kit", from: 1, to: 3, state: "booked", unit: "action-cam-kit-a" },
  { name: "Priya Patel", itemId: "projector", from: 2, to: 4, state: "booked", unit: "projector-a" },
  { name: "Isaac Moore", itemId: "camera-body", from: 2, to: 6, state: "booked", unit: "camera-body-a" },
  { name: "Ethan Brooks", itemId: "tele-lens", from: 2, to: 5, state: "booked", unit: "tele-lens-a" },
  { name: "Ava Nguyen", itemId: "ebike", from: 2, to: 5, state: "booked", unit: "ebike-b" },
  { name: "Maya Chen", itemId: "drone-kit", from: 3, to: 6, state: "booked", unit: "drone-kit-a" },
  { name: "Minh Pham", itemId: "city-bike", from: 3, to: 5, state: "booked", unit: "city-bike-a" },
  { name: "Omar Haddad", itemId: "camera-kit", from: 4, to: 7, state: "booked", unit: "camera-kit-a" },
  { name: "Diego Alvarez", itemId: "projector", from: 5, to: 7, state: "booked", unit: "projector-a" },
  { name: "Zoe Adams", itemId: "pa-speaker", from: 5, to: 6, state: "booked", unit: "pa-speaker-a" },
  { name: "Hannah Wright", itemId: "projector", from: 6, to: 9, state: "booked", unit: "projector-b" },
  { name: "Tom Becker", itemId: "action-cam-kit", from: 6, to: 9, state: "booked", unit: "action-cam-kit-a" },
  { name: "Mia Rossi", itemId: "ebike", from: 7, to: 9, state: "booked", unit: "ebike-a" },
  { name: "Chloe Martin", itemId: "tele-lens", from: 8, to: 10, state: "booked", unit: "tele-lens-a" },
  { name: "Sam Rivera", itemId: "drone-kit", from: 9, to: 12, state: "booked", unit: "drone-kit-a" },
  { name: "Ella Novak", itemId: "camera-kit", from: 9, to: 11, state: "booked", unit: "camera-kit-a" },
];

export const SEED_NAME = "schedule-two-weeks";

const email = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

async function seedOne(p: SeedPlan, today: string): Promise<string> {
  const db = await getDb();
  // A booking cannot start in the past, so one that is already under way is
  // booked from today for the same length, then moved back.
  const shift = Math.min(0, p.from);
  const { rentalId, orderId } = await svc.startBooking({
    itemId: p.itemId,
    name: p.name,
    email: email(p.name),
    startDate: addDaysIso(today, p.from - shift),
    endDate: addDaysIso(today, p.to - shift),
  });
  if (shift < 0) {
    await db.query("update rentals set start_date = start_date + $2::int, end_date = end_date + $2::int where id = $1", [rentalId, shift]);
    // Its unit was free from today; the days it moved back to may already be
    // drawn on that unit (the owner's dashboard seeds history there too).
    // Keep the unit when it is free for them, else take one that is.
    const moved = (await rentalById(db, rentalId))!;
    const unitId = await freeUnitFor(db, p.itemId, [{ start: moved.startDate, end: moved.endDate }], { now: new Date(), exceptRentalId: rentalId, prefer: moved.unitId });
    if (unitId && unitId !== moved.unitId) await db.query("update rentals set unit_id = $2 where id = $1", [rentalId, unitId]);
  }
  const { token } = await svc.confirmBooking(orderId);
  if (p.state === "booked") return rentalId;

  const scene = SCENE[p.itemId] ?? p.itemId;
  await svc.addPhoto(rentalId, "checkout", { sample: `${scene}/before` });
  await svc.holdDeposit(rentalId);
  await svc.acknowledgeCheckout(token);
  if (p.state === "out") return rentalId;

  await svc.addPhoto(rentalId, "checkin", { sample: `${scene}/${p.checkin}` });
  await svc.inspect(rentalId);
  if (p.state === "inspecting") return rentalId;

  const pending = awaitingCustomer((await latestAssessment(db, rentalId))!.findings);
  if (pending.length > 0) {
    await svc.sendToCustomer(rentalId);
    await svc.respondAsCustomer(
      token,
      pending.map((f) => ({ findingId: f.id, answer: "accept" as const })),
    );
  }
  if (p.state === "responded") return rentalId;
  await svc.settle(rentalId);
  return rentalId;
}

/**
 * Loads the plan once per database, in demo mode only: it books through the
 * PayPal stand-in, which a sandbox or live deployment must never do.
 */
export async function seedDemoSchedule(now = new Date()): Promise<string[]> {
  if (paypalConfig().mode !== "demo") return [];
  const db = await getDb();
  const claimed = await db.query("insert into demo_seeds (name) values ($1) on conflict (name) do nothing returning name", [SEED_NAME]);
  if (claimed.length === 0) return [];
  const today = todayIso(now);
  const ids: string[] = [];
  for (const p of SEED_PLAN) {
    // Visitors may have booked before the schedule first opened, so a unit the
    // plan wants can be taken. Skip that one booking and keep the rest; the
    // marker stays, because a second copy of the plan would be worse than a
    // short one.
    try {
      ids.push(await seedOne(p, today));
    } catch (err) {
      console.error(`demo schedule seed skipped ${p.name} (${p.itemId})`, err);
    }
  }
  return ids;
}

// ─── Sandbox ────────────────────────────────────────────────

/** A plan for the sandbox: from today on, and only booked or out, since nothing there can be moved back in time. */
export type SandboxSeedPlan = Omit<SeedPlan, "state" | "checkin"> & { state: "booked" | "out" };

/**
 * The schedule on a deployment that runs against the PayPal sandbox. Every
 * PayPal id behind it is real, so nothing starts in the past and nothing is
 * moved there: the plan is the demo fortnight from today on. Each booking
 * costs two sandbox calls (the booking order startBooking creates, left
 * unapproved, and the fee charged to the saved wallet); only the two rentals
 * that are out hold a deposit, one call more each. Jordan's projector carries
 * the repair story here too: it is out today, due back today, with Priya's
 * and Diego's bookings after it on the same unit and Hannah's on the other.
 *
 * The units are planned for a counter that the counter seed has just filled
 * (lib/seed/plan.ts), which runs first on the nightly reset and in
 * `npm run seed:demo`: its projector came back today and is drawn on
 * Projector A, so the story runs on Projector B. The same layout comes out
 * without the counter seed. Names the counter seed also uses are left out,
 * except Jordan's and Maya's, and every email here differs from the
 * counter's, so neither seed ever walks the other's rental.
 */
export const SANDBOX_SEED_PLAN: SandboxSeedPlan[] = [
  { name: "Jordan Lee", itemId: "projector", from: 0, to: 0, state: "out", unit: "projector-b" },
  { name: "Liam Walsh", itemId: "ebike", from: 0, to: 3, state: "out", unit: "ebike-a" },
  { name: "Kai Tanaka", itemId: "drone-kit", from: 1, to: 2, state: "booked", unit: "drone-kit-b" },
  { name: "Leo Garcia", itemId: "action-cam-kit", from: 1, to: 3, state: "booked", unit: "action-cam-kit-a" },
  { name: "Grace Liu", itemId: "camera-kit", from: 1, to: 3, state: "booked", unit: "camera-kit-b" },
  { name: "Priya Patel", itemId: "projector", from: 2, to: 4, state: "booked", unit: "projector-b" },
  { name: "Isaac Moore", itemId: "camera-body", from: 2, to: 6, state: "booked", unit: "camera-body-a" },
  { name: "Ethan Brooks", itemId: "tele-lens", from: 2, to: 5, state: "booked", unit: "tele-lens-b" },
  { name: "Minh Pham", itemId: "city-bike", from: 3, to: 5, state: "booked", unit: "city-bike-a" },
  { name: "Diego Alvarez", itemId: "projector", from: 5, to: 7, state: "booked", unit: "projector-b" },
  { name: "Zoe Adams", itemId: "pa-speaker", from: 5, to: 6, state: "booked", unit: "pa-speaker-a" },
  { name: "Hannah Wright", itemId: "projector", from: 6, to: 9, state: "booked", unit: "projector-a" },
  { name: "Mia Rossi", itemId: "ebike", from: 7, to: 9, state: "booked", unit: "ebike-a" },
  // The schedule's command box suggests "Move Maya's drone booking to the other unit"; Drone kit A is free then.
  { name: "Maya Chen", itemId: "drone-kit", from: 7, to: 10, state: "booked", unit: "drone-kit-b" },
  { name: "Chloe Martin", itemId: "tele-lens", from: 8, to: 10, state: "booked", unit: "tele-lens-a" },
  { name: "Ella Novak", itemId: "camera-kit", from: 9, to: 11, state: "booked", unit: "camera-kit-a" },
];

/** The sandbox plan's renters, at addresses no other seed or test uses (example.com is reserved, RFC 2606). */
export const sandboxSeedEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}+schedule@example.com`;

const sandboxScenario = (p: SandboxSeedPlan): SeedScenario => ({
  name: p.name,
  email: sandboxSeedEmail(p.name),
  itemId: p.itemId,
  startsInDays: p.from,
  days: p.to - p.from,
  returnSample: null,
  target: p.state,
  unit: p.unit,
});

/**
 * Books SANDBOX_SEED_PLAN through the real rental service against the PayPal
 * sandbox, paying each fee with the saved wallet `vaultId`, as the counter
 * seed does there (lib/seed/run.ts). It converges like that seed: each
 * rental is found by its renter's email and only its missing steps run, so a
 * second run the same day books and charges nothing, and an interrupted one
 * picks up where it stopped. The nightly reset wipes the rentals, so it
 * books the plan again once per reset day. It does nothing in demo mode,
 * which has its own fortnight (seedDemoSchedule), refuses live PayPal, and
 * needs a saved wallet.
 */
export async function seedSandboxSchedule(opts: { vaultId?: string } = {}): Promise<SeedReport> {
  const mode = depositGateway().mode;
  if (mode === "live") return { mode, skipped: "PayPal is live. The schedule seed moves money, so it only runs against the sandbox.", lines: [] };
  if (mode === "demo") return { mode, skipped: "Demo mode books its own two weeks the first time the schedule opens (seedDemoSchedule).", lines: [] };
  if (!opts.vaultId) {
    return { mode, skipped: "PayPal is in sandbox mode and SEED_VAULT_ID is not set, so no booking fee can be paid. Nothing was booked on the schedule.", lines: [] };
  }
  const lines = [];
  for (const p of SANDBOX_SEED_PLAN) lines.push(await convergeScenario(sandboxScenario(p), opts.vaultId));
  return { mode, lines };
}
