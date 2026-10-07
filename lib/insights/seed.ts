import "server-only";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import * as desk from "@/lib/disputes/service";
import { paypalConfig } from "@/lib/paypal/config";
import { cancelAtCounter } from "@/lib/rentals/cancel";
import { refundCharge } from "@/lib/rentals/refunds";
import { latestAssessment, rentalById } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";

/**
 * Six weeks of sample history for the owner's dashboard in demo mode, so the
 * page has something to show on a fresh copy. Every rental goes through the
 * same service calls a real one does (booking, the PayPal stand-in, photos,
 * the recorded Gemini looks, the renter's answers, settlement, refunds,
 * cancelling, the dispute stand-in). Then its dates and timestamps are moved
 * back in time, as the schedule's sample data is moved, because a real
 * booking cannot start in the past. The audit trails keep the real times.
 *
 * Active holds use items the end-to-end tests do not book, and finished
 * rentals hold no unit, so the seed does not change what visitors can book.
 */

export const INSIGHTS_SEED = "insights-history";

type Plan = {
  name: string;
  itemId: string;
  /** Pickup and return, as days from today. */
  from: number;
  to: number;
  /** Return photo for rentals that came back. */
  checkin?: string;
  answer?: "accept" | "contest";
  /** What happened after the return. */
  end: "out" | "responded" | "settled" | "cancelled";
  /** Hours from booking to pickup, minutes from the return photo to settling. */
  leadHours?: number;
  settleMinutes?: number;
  after?: "refund" | "dispute-lost" | "dispute-open";
};

const SCENE: Record<string, string> = { ebike: "ebike-rear" };

export const INSIGHTS_PLAN: Plan[] = [
  { name: "Olivia Grant", itemId: "pa-speaker", from: -40, to: -37, checkin: "after__grille-dent", answer: "accept", end: "settled", leadHours: 52, settleMinutes: 14 },
  { name: "Marco Silva", itemId: "tele-lens", from: -33, to: -30, checkin: "after__same-light", end: "settled", leadHours: 30, settleMinutes: 6 },
  { name: "Aisha Bello", itemId: "camera-body", from: -26, to: -22, checkin: "after__top-scratch", answer: "contest", end: "settled", leadHours: 71, settleMinutes: 185 },
  { name: "Hugo Laurent", itemId: "drone-kit", from: -20, to: -17, checkin: "after__broken-propeller", answer: "accept", end: "settled", leadHours: 26, settleMinutes: 22, after: "refund" },
  { name: "Yuki Sato", itemId: "action-cam-kit", from: -14, to: -12, checkin: "after__missing-housing", answer: "accept", end: "settled", leadHours: 8, settleMinutes: 17, after: "dispute-lost" },
  { name: "Noah Fischer", itemId: "ebike", from: -9, to: -6, checkin: "after__bent-fender-mud", answer: "accept", end: "settled", leadHours: 44, settleMinutes: 31, after: "dispute-open" },
  { name: "Emma Rossi", itemId: "camera-body", from: -6, to: -4, checkin: "after__same-pose", end: "settled", leadHours: 19, settleMinutes: 9 },
  { name: "Lucas Meyer", itemId: "camera-body", from: 20, to: 23, end: "cancelled" },
  { name: "Kofi Mensah", itemId: "tele-lens", from: -2, to: -1, checkin: "after__dent", answer: "accept", end: "responded", leadHours: 27 },
  { name: "Sara Kim", itemId: "tele-lens", from: -5, to: 2, end: "out", leadHours: 36 },
  { name: "Tom Novak", itemId: "pa-speaker", from: -1, to: 2, end: "out", leadHours: 22 },
  { name: "Lena Park", itemId: "action-cam-kit", from: -18, to: 3, end: "out", leadHours: 60 },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const email = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

async function seedOne(p: Plan, now: Date): Promise<string> {
  const db = await getDb();
  const today = todayIso(now);
  // Book future dates as they are; book past ones from today and move them back afterwards.
  const shift = Math.min(0, p.from);
  const { rentalId, orderId } = await svc.startBooking({
    itemId: p.itemId,
    name: p.name,
    email: email(p.name),
    startDate: addDaysIso(today, p.from - shift),
    endDate: addDaysIso(today, p.to - shift),
  });
  const { token } = await svc.confirmBooking(orderId);

  if (p.end === "cancelled") {
    const r = (await rentalById(db, rentalId))!;
    await cancelAtCounter(rentalId, { refundCents: r.feeCents, reason: "The shop is closed for a stock check that week." });
  } else {
    const scene = SCENE[p.itemId] ?? p.itemId;
    await svc.addPhoto(rentalId, "checkout", { sample: `${scene}/before` });
    await svc.holdDeposit(rentalId);
    await svc.acknowledgeCheckout(token);
    if (p.checkin) {
      await svc.addPhoto(rentalId, "checkin", { sample: `${scene}/${p.checkin}` });
      await svc.inspect(rentalId);
      const pending = awaitingCustomer((await latestAssessment(db, rentalId))!.findings);
      if (pending.length > 0) {
        await svc.sendToCustomer(rentalId);
        await svc.respondAsCustomer(
          token,
          pending.map((f) => ({ findingId: f.id, answer: p.answer ?? "accept", note: p.answer === "contest" ? "That scratch was there when I picked it up." : undefined })),
        );
        if (p.answer === "contest") for (const f of pending) await svc.resolveContest(rentalId, f.id, "waive");
      }
      if (p.end === "settled") await svc.settle(rentalId);
    }
  }
  if (p.after === "refund") {
    const r = (await rentalById(db, rentalId))!;
    if (r.settlementCaptureId) await refundCharge(rentalId, { captureId: r.settlementCaptureId, cents: 500, reason: "One propeller was already chipped at pickup.", seq: 1 });
  }
  if (p.after === "dispute-lost" || p.after === "dispute-open") {
    await desk.demoOpenDispute(rentalId);
    if (p.after === "dispute-lost") await desk.acceptClaim(rentalId);
  }

  // Move it back in time: dates, then the timestamps the dashboard reads.
  const pickup = new Date(`${addDaysIso(today, p.from)}T15:00:00Z`).getTime();
  const booked = pickup - (p.leadHours ?? 48) * HOUR;
  const returned = new Date(`${addDaysIso(today, p.to)}T16:30:00Z`).getTime();
  const iso = (t: number) => new Date(Math.min(t, now.getTime())).toISOString();
  if (shift < 0) await db.query("update rentals set start_date = start_date + $2::int, end_date = end_date + $2::int where id = $1", [rentalId, shift]);
  await db.query("update rentals set created_at = $2 where id = $1", [rentalId, iso(p.end === "cancelled" ? now.getTime() - 3 * DAY : booked)]);
  if (p.end === "cancelled") {
    await db.query("update rentals set cancelled_at = $2 where id = $1", [rentalId, iso(now.getTime() - 2 * DAY)]);
    await db.query("update refunds set created_at = $2 where rental_id = $1", [rentalId, iso(now.getTime() - 2 * DAY)]);
    return rentalId;
  }
  await db.query("update rentals set authorized_at = $2, authorization_expires_at = $3 where id = $1", [rentalId, iso(pickup), new Date(pickup + 29 * DAY).toISOString()]);
  await db.query("update inspections set taken_at = $2 where rental_id = $1 and phase = 'checkout'", [rentalId, iso(pickup - 5 * 60_000)]);
  if (p.checkin) {
    await db.query("update inspections set taken_at = $2 where rental_id = $1 and phase = 'checkin'", [rentalId, iso(returned)]);
    await db.query("update assessments set created_at = $2 where rental_id = $1", [rentalId, iso(returned + 2 * 60_000)]);
  }
  if (p.end === "settled") {
    const settled = returned + (p.settleMinutes ?? 15) * 60_000;
    await db.query("update rentals set settled_at = $2 where id = $1", [rentalId, iso(settled)]);
    await db.query("update refunds set created_at = $2 where rental_id = $1", [rentalId, iso(settled + 2 * DAY)]);
  }
  return rentalId;
}

/** Loads the plan once per database, in demo mode only: it books through the PayPal stand-in. */
export async function seedInsightsHistory(now = new Date()): Promise<string[]> {
  if (paypalConfig().mode !== "demo") return [];
  const db = await getDb();
  const claimed = await db.query("insert into demo_seeds (name) values ($1) on conflict (name) do nothing returning name", [INSIGHTS_SEED]);
  if (claimed.length === 0) return [];
  const ids: string[] = [];
  for (const p of INSIGHTS_PLAN) {
    // A visitor may already have the unit a plan wants; skip that one and keep the rest.
    try {
      ids.push(await seedOne(p, now));
    } catch (err) {
      console.error(`insights seed skipped ${p.name} (${p.itemId})`, err);
    }
  }
  return ids;
}
