// The dashboard's sample history next to the other demo seeds, in every
// order they can run on a real copy: the counter seed (a fresh deployment's
// hook and the nightly reset), the schedule's (its first visit, or the
// reset) and this one (the dashboard's first visit, or the reset last). All
// of it must seed, it must not cost the others a booking, and it must not
// put two things on one unit on the same day.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;

const { getDb } = await import("@/lib/db/client");
const { dropDemoStandIns, depositGateway } = await import("@/lib/paypal");
const { WIPED_TABLES, resetDemo } = await import("@/lib/demo-reset/reset");
const { seedCounter } = await import("@/lib/seed/run");
const { seedDemoSchedule, SEED_PLAN } = await import("@/lib/schedule/seed");
const { seedInsightsHistory, seedInsightsHistoryOnce, INSIGHTS_PLAN, STAGING_DAYS } = await import("./seed");
const { loadInsights } = await import("./load");
const { toRental } = await import("@/lib/rentals/repo");
const { returnDays } = await import("@/lib/schedule/repo");
const { displaySpan, overlaps } = await import("@/lib/schedule/spans");
const { addDaysIso, todayIso } = await import("@/lib/dates");

async function wipe() {
  const db = await getDb();
  await db.query(`truncate table ${WIPED_TABLES.join(", ")} restart identity`);
  dropDemoStandIns();
}

/** Same-unit overlaps on the timeline that involve the dashboard's history: rentals as drawn, and repair blocks. */
async function clashes(history: Set<string>): Promise<string[]> {
  const db = await getDb();
  const rentals = (await db.query<Record<string, unknown>>("select * from rentals where unit_id is not null and status not in ('draft', 'cancelled')")).map(toRental);
  const back = await returnDays(
    db,
    rentals.map((r) => r.id),
  );
  const drawn = rentals.map((r) => ({ id: r.id, who: `${r.customerName} (${r.status})`, unit: r.unitId!, span: displaySpan(r, back.get(r.id) ?? null)! }));
  const blocks = (await db.query<{ id: string; unit_id: string; start_date: unknown; end_date: unknown; rental_id: string | null }>("select * from blocks")).map((b) => ({
    id: b.id,
    unit: b.unit_id,
    rentalId: b.rental_id,
    span: { start: String(b.start_date instanceof Date ? b.start_date.toISOString() : b.start_date).slice(0, 10), end: String(b.end_date instanceof Date ? b.end_date.toISOString() : b.end_date).slice(0, 10) },
  }));
  const out: string[] = [];
  for (const a of drawn)
    for (const b of drawn)
      if (a.id < b.id && a.unit === b.unit && overlaps(a.span, b.span) && (history.has(a.id) || history.has(b.id))) out.push(`${a.unit}: ${a.who} x ${b.who}`);
  for (const k of blocks)
    for (const r of drawn)
      if (k.unit === r.unit && k.rentalId !== r.id && overlaps(k.span, r.span) && ((k.rentalId && history.has(k.rentalId)) || history.has(r.id))) out.push(`${k.unit}: repair block of ${k.rentalId} x ${r.who}`);
  for (const a of blocks)
    for (const b of blocks)
      if (a.id < b.id && a.unit === b.unit && overlaps(a.span, b.span) && [a.rentalId, b.rentalId].some((id) => id && history.has(id))) out.push(`${a.unit}: blocks of ${a.rentalId} x ${b.rentalId}`);
  return out;
}

/** Every rental the dashboard's plan names, so a half-made one would show. */
async function historyRentals(): Promise<{ id: string; status: string; start_date: string }[]> {
  const db = await getDb();
  return db.query("select id, status, start_date::text from rentals where customer_name = any($1)", [INSIGHTS_PLAN.map((p) => p.name)]);
}

async function counterSeeded(): Promise<number> {
  const report = await seedCounter({});
  expect(report.lines.filter((l) => l.stopped)).toEqual([]);
  return report.lines.filter((l) => l.rentalId).length;
}

/** What the schedule seeds after the counter's, without the dashboard: the count the dashboard must not lower. */
let afterCounter = 0;
// Each test books dozens of rentals through the real service; a busy machine running the whole suite needs the room.
const SLOW = 180_000;

beforeEach(async () => {
  await getDb();
  await wipe();
});

describe("the dashboard's sample history next to the other demo seeds", () => {
  it("measures the schedule seed after the counter's, without the dashboard", async () => {
    await counterSeeded();
    afterCounter = (await seedDemoSchedule()).length;
    expect(afterCounter).toBeGreaterThan(SEED_PLAN.length / 2);
  }, SLOW);

  it("dashboard first, then the schedule: everything seeds and nothing shares a unit", async () => {
    const history = await seedInsightsHistory();
    expect(history).toHaveLength(INSIGHTS_PLAN.length);
    // Every one of the schedule's plans, as on a database without the dashboard.
    expect(await seedDemoSchedule()).toHaveLength(SEED_PLAN.length);
    expect(await clashes(new Set(history))).toEqual([]);
  }, SLOW);

  it("a fresh deployment opened on the dashboard: counter, dashboard, then schedule", async () => {
    await counterSeeded();
    const history = await seedInsightsHistory();
    expect(history).toHaveLength(INSIGHTS_PLAN.length);
    expect(await seedDemoSchedule()).toHaveLength(afterCounter);
    expect(await clashes(new Set(history))).toEqual([]);
  }, SLOW);

  it("the nightly reset seeds counter, schedule, then the dashboard, after a visit had seeded it", async () => {
    expect(await seedInsightsHistory()).toHaveLength(INSIGHTS_PLAN.length);
    const result = await resetDemo({ env: { ...process.env, DEMO_RESET: "true" } });
    expect(result).toMatchObject({ status: "reset", seeded: { counter: 6, schedule: afterCounter, insights: INSIGHTS_PLAN.length } });
    const history = (await historyRentals()).map((r) => r.id);
    expect(history).toHaveLength(INSIGHTS_PLAN.length);
    expect(await clashes(new Set(history))).toEqual([]);
    // Nothing is left booked far ahead, where the plans were walked through.
    const far = addDaysIso(todayIso(), STAGING_DAYS - 1);
    expect((await historyRentals()).filter((r) => r.start_date >= far)).toEqual([]);
  }, SLOW);

  it("makes a page request that arrives during the seeding wait for all of it", async () => {
    const [first, second] = await Promise.all([seedInsightsHistoryOnce(), seedInsightsHistoryOnce()]);
    expect(first).toHaveLength(INSIGHTS_PLAN.length);
    expect(second).toBe(first);
    expect(await seedInsightsHistoryOnce()).toEqual([]);
  }, SLOW);

  it("with a key set: recorded replies, the stand-in's clock with the moved-back holds, and the renewal that is due", async () => {
    process.env.GEMINI_API_KEY = "not-a-real-key";
    process.env.DEMO_MODE = "false";
    try {
      const history = await seedInsightsHistory();
      expect(history).toHaveLength(INSIGHTS_PLAN.length);
      const db = await getDb();
      expect(await db.query<{ source: string }>("select distinct source from assessments where rental_id = any($1)", [history])).toEqual([{ source: "replay" }]);

      const sara = (await loadInsights()).holds.find((h) => h.renter === "Sara")!;
      expect(sara).toMatchObject({ state: "Renewed, keeps the first expiry", renewed_at: expect.any(String) });
      expect(sara.authorization_id).not.toBe(sara.original_authorization_id);
      const holds = (await db.query<Record<string, unknown>>("select * from rentals where id = any($1) and status in ('out', 'responded')", [history])).map(toRental);
      expect(holds.length).toBe(4);
      for (const r of holds) {
        const auth = await depositGateway().getAuthorization(r.authorizationId!);
        // The stand-in's hold expires when the database says, 29 days after the moved-back pickup.
        expect(auth.expiresAt, r.customerName).toBe(r.authorizationExpiresAt);
      }
      // The hourly job finds nothing more to do, and writes no PayPal error.
      const { renewDueHolds } = await import("@/lib/rentals/jobs");
      expect((await renewDueHolds(new Date())).filter((o) => o.outcome !== "not-due")).toEqual([]);
      expect(await db.query("select seq from events where type = 'paypal.error'")).toEqual([]);
    } finally {
      process.env.DEMO_MODE = "true";
      delete process.env.GEMINI_API_KEY;
    }
  }, SLOW);
});
