import "server-only";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { paypalConfig } from "@/lib/paypal/config";
import { latestAssessment, rentalById } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import { freeUnitFor } from "./place";

// Two weeks of bookings for demo mode, so the schedule has something to show
// the first time it opens. Every rental goes through the same service calls a
// real one does (booking, PayPal stand-in, photos, inspection, settlement);
// the only shortcut is moving a few of them back in time afterwards, because
// a real booking can never start in the past.

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
