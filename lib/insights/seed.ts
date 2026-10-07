import "server-only";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import * as desk from "@/lib/disputes/service";
import { depositGateway } from "@/lib/paypal";
import { paypalConfig } from "@/lib/paypal/config";
import { DemoDepositGateway } from "@/lib/paypal/demo-gateway";
import { cancelAtCounter } from "@/lib/rentals/cancel";
import { renewDueHolds } from "@/lib/rentals/jobs";
import { refundCharge } from "@/lib/rentals/refunds";
import { latestAssessment, rentalById } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import { repairNeeded } from "@/lib/schedule/agent";
import { freeUnitFor } from "@/lib/schedule/place";

/**
 * Six weeks of sample history for the owner's dashboard in demo mode, so the
 * page has something to show on a fresh copy. Every rental goes through the
 * same service calls a real one does (booking, the PayPal stand-in, photos,
 * the recorded Gemini looks, the renter's answers, settlement, refunds,
 * cancelling, the dispute stand-in, the hourly renewal).
 *
 * A real booking cannot start in the past, so each one is booked 99 to 120
 * days ahead, where no other seed and no test books, walked through its
 * story there, and then moved to its days in the past onto a unit that is
 * free for them: nothing else drawn on that unit on those days, and no
 * repair block after it overlapping another rental. A damaged return is
 * settled on a unit that is also free today, because the repair block the
 * schedule agent puts on it from the settlement day must not clash with a
 * real booking; the block then moves back with the rental. The PayPal
 * stand-in's holds move back too, so its clock agrees with the database.
 * The audit trails keep the real times.
 *
 * Running holds use items with spare units, and end within three days, so
 * the counter's and the schedule's sample bookings still find a free unit
 * whichever seed runs first. A plan that fails part way is undone: its hold
 * voided and its rows deleted, so no half-made rental keeps a unit.
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
  // Held five days and due back tomorrow: the renewal is due, and the seed runs the hourly job's renewal for it.
  { name: "Sara Kim", itemId: "ebike", from: -5, to: 1, end: "out", leadHours: 36 },
  { name: "Tom Novak", itemId: "camera-body", from: -1, to: 2, end: "out", leadHours: 22 },
  { name: "Lena Park", itemId: "action-cam-kit", from: -18, to: 3, end: "out", leadHours: 60 },
];

/** Where plans are booked before they move back: bookings open 120 days ahead, and nothing else books this far out. */
export const STAGING_DAYS = 99;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const email = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
const HOLDING = ["out", "inspecting", "customer_review", "responded"];

async function seedOne(p: Plan, now: Date, made: { id: string | null }): Promise<string> {
  const db = await getDb();
  const today = todayIso(now);
  const stage = addDaysIso(today, STAGING_DAYS);
  const { rentalId, orderId } = await svc.startBooking({ itemId: p.itemId, name: p.name, email: email(p.name), startDate: stage, endDate: addDaysIso(stage, p.to - p.from) });
  made.id = rentalId;
  const { token } = await svc.confirmBooking(orderId);
  const target = { start: addDaysIso(today, p.from), end: addDaysIso(today, p.to) };
  const iso = (t: number) => new Date(Math.min(t, now.getTime())).toISOString();

  if (p.end === "cancelled") {
    const r = (await rentalById(db, rentalId))!;
    await cancelAtCounter(rentalId, { refundCents: r.feeCents, reason: "The shop is closed for a stock check that week." });
    await db.query("update rentals set start_date = $2, end_date = $3, created_at = $4, cancelled_at = $5 where id = $1", [
      rentalId,
      target.start,
      target.end,
      iso(now.getTime() - 3 * DAY),
      iso(now.getTime() - 2 * DAY),
    ]);
    await db.query("update refunds set created_at = $2 where rental_id = $1", [rentalId, iso(now.getTime() - 2 * DAY)]);
    return rentalId;
  }

  const scene = SCENE[p.itemId] ?? p.itemId;
  await svc.addPhoto(rentalId, "checkout", { sample: `${scene}/before` });
  await svc.holdDeposit(rentalId);
  await svc.acknowledgeCheckout(token);
  let repairDays = 0;
  if (p.checkin) {
    await svc.addPhoto(rentalId, "checkin", { sample: `${scene}/${p.checkin}` });
    await svc.inspect(rentalId, undefined, { recordedOnly: true });
    const pending = awaitingCustomer((await latestAssessment(db, rentalId))!.findings);
    if (pending.length > 0) {
      await svc.sendToCustomer(rentalId);
      await svc.respondAsCustomer(
        token,
        pending.map((f) => ({ findingId: f.id, answer: p.answer ?? "accept", note: p.answer === "contest" ? "That scratch was there when I picked it up." : undefined })),
      );
      if (p.answer === "contest") for (const f of pending) await svc.resolveContest(rentalId, f.id, "waive");
    }
    if (p.end === "settled") repairDays = repairNeeded((await latestAssessment(db, rentalId))!.findings)?.days ?? 0;
  }

  // Move it to its days, on a unit free for them, for the repair block after
  // them, and (for a damaged return) for the block the settlement puts on it today.
  const repair = repairDays ? [{ start: target.end, end: addDaysIso(target.end, repairDays - 1) }] : [];
  const unitId = await freeUnitFor(db, p.itemId, [target, ...repair], {
    now,
    exceptRentalId: rentalId,
    whileHeld: repairDays ? [{ start: today, end: addDaysIso(today, repairDays - 1) }] : [],
  });
  if (!unitId) throw new Error(`no ${p.itemId} unit is free for ${target.start}..${target.end}`);
  const pickup = new Date(`${target.start}T15:00:00Z`).getTime();
  const returned = new Date(`${target.end}T16:30:00Z`).getTime();
  await db.query("update rentals set start_date = $2, end_date = $3, unit_id = $4, created_at = $5, authorized_at = $6, authorization_expires_at = $7 where id = $1", [
    rentalId,
    target.start,
    target.end,
    unitId,
    iso(pickup - (p.leadHours ?? 48) * HOUR),
    iso(pickup),
    new Date(pickup + 29 * DAY).toISOString(),
  ]);
  await db.query("update inspections set taken_at = $2 where rental_id = $1 and phase = 'checkout'", [rentalId, iso(pickup - 5 * 60_000)]);
  if (p.checkin) {
    await db.query("update inspections set taken_at = $2 where rental_id = $1 and phase = 'checkin'", [rentalId, iso(returned)]);
    await db.query("update assessments set created_at = $2 where rental_id = $1", [rentalId, iso(returned + 2 * 60_000)]);
  }
  // The stand-in's clock moves back with the hold (a settled one is captured first, before 29 days run out).
  const gateway = depositGateway();
  const hold = (await rentalById(db, rentalId))!.authorizationId!;
  if (p.end !== "settled" && gateway instanceof DemoDepositGateway) await gateway.backdateAuthorization(hold, new Date(pickup));

  if (p.end === "settled") {
    await svc.settle(rentalId);
    const settled = returned + (p.settleMinutes ?? 15) * 60_000;
    await db.query("update rentals set settled_at = $2 where id = $1", [rentalId, iso(settled)]);
    // The repair block starts on the settlement day; that day is in the past too.
    await db.query("update blocks set start_date = start_date + $2::int, end_date = end_date + $2::int where rental_id = $1", [rentalId, p.to]);
    if (gateway instanceof DemoDepositGateway) await gateway.backdateAuthorization(hold, new Date(pickup));
    if (p.after === "refund") {
      const r = (await rentalById(db, rentalId))!;
      if (r.settlementCaptureId) await refundCharge(rentalId, { captureId: r.settlementCaptureId, cents: 500, reason: "One propeller was already chipped at pickup.", seq: 1 });
      await db.query("update refunds set created_at = $2 where rental_id = $1", [rentalId, iso(settled + 2 * DAY)]);
    }
    if (p.after === "dispute-lost" || p.after === "dispute-open") {
      await desk.demoOpenDispute(rentalId);
      if (p.after === "dispute-lost") await desk.acceptClaim(rentalId);
    }
  }
  return rentalId;
}

/** Undoes a plan that failed part way: voids its hold and deletes its rows, so it keeps no unit. */
async function discard(rentalId: string): Promise<void> {
  const db = await getDb();
  const r = await rentalById(db, rentalId);
  if (!r) return;
  if (r.authorizationId && HOLDING.includes(r.status)) {
    await depositGateway()
      .release(r.authorizationId, `seed-discard:${rentalId}`)
      .catch(() => {});
  }
  await db.tx(async (tx) => {
    const blocks = (await tx.query<{ id: string }>("select id from blocks where rental_id = $1", [rentalId])).map((b) => b.id);
    const disputes = (await tx.query<{ id: string }>("select id from disputes where rental_id = $1", [rentalId])).map((d) => d.id);
    await tx.query("delete from schedule_proposals where rental_id = $1 or block_id = any($2)", [rentalId, blocks]);
    await tx.query("delete from blocks where rental_id = $1", [rentalId]);
    await tx.query("delete from dispute_actions where dispute_id = any($1)", [disputes]);
    for (const table of ["evidence_packs", "disputes", "refunds", "assessments", "inspections", "events"]) await tx.query(`delete from ${table} where rental_id = $1`, [rentalId]);
    await tx.query("delete from rentals where id = $1", [rentalId]);
  });
}

/** Loads the plan once per database, in demo mode only: it books through the PayPal stand-in. */
export async function seedInsightsHistory(now = new Date()): Promise<string[]> {
  if (paypalConfig().mode !== "demo") return [];
  const db = await getDb();
  const claimed = await db.query("insert into demo_seeds (name) values ($1) on conflict (name) do nothing returning name", [INSIGHTS_SEED]);
  if (claimed.length === 0) return [];
  const ids: string[] = [];
  for (const p of INSIGHTS_PLAN) {
    const made = { id: null as string | null };
    try {
      ids.push(await seedOne(p, now, made));
    } catch (err) {
      console.error(`insights seed skipped ${p.name} (${p.itemId})`, err);
      if (made.id) await discard(made.id).catch((e) => console.error(`insights seed could not undo ${made.id}`, e));
    }
  }
  // The hourly job's renewal, for the seeded holds that are due (Sara Kim's).
  await renewDueHolds(now, depositGateway(), ids).catch((err) => console.error("insights seed renewal failed", err));
  return ids;
}
