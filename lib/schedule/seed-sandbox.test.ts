// The schedule's sandbox seed, with the PayPal stand-in playing the sandbox:
// a gateway that says "sandbox", passes every call to a stand-in of its own
// and counts them, so the test sees each PayPal call the seed would make.
// A Gemini key is set for the whole file, so any live comparison would fail:
// seeding must replay the recorded replies.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "memory";
process.env.DEMO_MODE = "false";
process.env.GEMINI_API_KEY = "not-a-real-key";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.DEMO_RESET;
delete process.env.PAYPAL_ENVIRONMENT;

const { getDb } = await import("@/lib/db/client");
const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
const { WIPED_TABLES, resetDemo } = await import("@/lib/demo-reset/reset");
const { seedCounter } = await import("@/lib/seed/run");
const { SCENARIOS } = await import("@/lib/seed/plan");
const rentals = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { awaitingCustomer } = await import("@/lib/rentals/settlement");
const repo = await import("./repo");
const { displaySpan, overlaps } = await import("./spans");
const { SANDBOX_SEED_PLAN, sandboxSeedEmail, seedSandboxSchedule } = await import("./seed");
const { interpretCommand } = await import("./commands");
const { addDaysIso, todayIso } = await import("@/lib/dates");

const slot = globalThis as { depositGateway?: unknown };
const T = (n: number) => addDaysIso(todayIso(), n);
const SLOW = 120_000;

type Calls = Record<string, number>;

/** The stand-in as the sandbox, and a saved wallet on it, as a sandbox buyer's would be. */
async function sandbox() {
  const inner = new DemoDepositGateway();
  const calls: Calls = {};
  const gateway = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "mode") return "sandbox";
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  });
  const order = await inner.createBookingOrder(
    { rentalId: "R-BUYER1", itemName: "City bike", rentalDays: 1, feeCents: 1500, depositCents: 15000, shopName: "Kestrel Rentals", returnUrl: "http://x/r", cancelUrl: "http://x/c" },
    "buyer-order",
  );
  const { vaultId } = await inner.captureBookingOrder(order.orderId, "buyer-capture");
  slot.depositGateway = gateway;
  const counted = () => ({ ...calls });
  return { vaultId: vaultId!, calls: counted, reset: () => Object.keys(calls).forEach((k) => delete calls[k]) };
}

async function all() {
  const db = await getDb();
  return (await db.query<Record<string, unknown>>("select * from rentals order by created_at")).map(rentals.toRental);
}

/** Two things drawn on one unit on the same day: rentals as the timeline draws them, and blocks (a repair block starts on its own rental's return day). */
async function clashes(): Promise<string[]> {
  const db = await getDb();
  const rows = (await all()).filter((r) => r.unitId && r.status !== "draft" && r.status !== "cancelled");
  const back = await repo.returnDays(
    db,
    rows.map((r) => r.id),
  );
  const drawn = [
    ...rows.map((r) => ({ id: r.id, rental: r.id, who: `${r.customerName} (${r.status})`, unit: r.unitId!, span: displaySpan(r, back.get(r.id) ?? null)! })),
    ...(await repo.listBlocks(db, "2000-01-01", "2100-01-01")).map((b) => ({ id: b.id, rental: b.rentalId, who: `block ${b.reason}`, unit: b.unitId, span: { start: b.startDate, end: b.endDate } })),
  ];
  const out: string[] = [];
  for (const a of drawn)
    for (const b of drawn) if (a.id < b.id && a.unit === b.unit && a.rental !== b.rental && overlaps(a.span, b.span)) out.push(`${a.unit}: ${a.who} x ${b.who}`);
  return out;
}

/** Every plan on its planned unit and dates, at its state, paid with the saved wallet. */
async function expectPlanSeeded(vaultId: string) {
  const db = await getDb();
  for (const p of SANDBOX_SEED_PLAN) {
    const [row] = await db.query<Record<string, unknown>>("select * from rentals where customer_email = $1", [sandboxSeedEmail(p.name)]);
    const r = rentals.toRental(row);
    expect([r.unitId, r.startDate, r.endDate, r.status], p.name).toEqual([p.unit, T(p.from), T(p.to), p.state]);
    expect(r.feeCaptureId, p.name).toBeTruthy();
    expect(r.vaultId, p.name).toBe(vaultId);
    expect(Boolean(r.authorizationId), p.name).toBe(p.state === "out");
  }
}

const BOOKINGS = SANDBOX_SEED_PLAN.length;
const HOLDS = SANDBOX_SEED_PLAN.filter((p) => p.state === "out").length;
/** The counter seed in the sandbox: six bookings, five holds, one settlement capture and one void. */
const COUNTER_CALLS = { createBookingOrder: 6, chargeSavedWallet: 6, holdWithSavedWallet: 5, settle: 1, release: 1 };

beforeEach(async () => {
  const db = await getDb();
  await db.query(`truncate table ${WIPED_TABLES.join(", ")} restart identity`);
});

afterEach(() => {
  slot.depositGateway = undefined;
});

describe("the schedule's sandbox seed", () => {
  it("after the counter seed: every plan on its unit, nothing drawn twice on a day, two calls a booking and one a hold", async () => {
    const { vaultId, calls, reset } = await sandbox();
    expect((await seedCounter({ vaultId })).lines.filter((l) => l.stopped)).toEqual([]);
    expect(calls()).toEqual(COUNTER_CALLS);
    reset();

    const report = await seedSandboxSchedule({ vaultId });
    expect(report.mode).toBe("sandbox");
    expect(report.lines.filter((l) => l.stopped)).toEqual([]);
    expect(report.lines).toHaveLength(BOOKINGS);
    await expectPlanSeeded(vaultId);
    expect(await clashes()).toEqual([]);
    // Only the booking order, the fee on the saved wallet, and the two holds.
    expect(calls()).toEqual({ createBookingOrder: BOOKINGS, chargeSavedWallet: BOOKINGS, holdWithSavedWallet: HOLDS });
    expect(BOOKINGS * 2 + HOLDS).toBe(34);

    // The seeded returns were compared with the recorded replies, never live Gemini.
    const db = await getDb();
    expect(await db.query("select distinct source from assessments")).toEqual([{ source: "replay" }]);

    // A second run the same day books, charges and holds nothing.
    reset();
    const again = await seedSandboxSchedule({ vaultId });
    expect(again.lines.every((l) => l.ran.length === 0 && !l.stopped)).toBe(true);
    expect((await seedCounter({ vaultId })).lines.every((l) => l.ran.length === 0 && !l.stopped)).toBe(true);
    expect(calls()).toEqual({});
    expect(await all()).toHaveLength(SCENARIOS.length + BOOKINGS);

    // The command box's example works on this schedule too (the counter's Maya rents a camera kit).
    const moved = await interpretCommand("Move Maya's drone booking to the other unit", new Date(), null);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.proposal).toMatchObject({ kind: "reassign", fromUnitId: "drone-kit-b", toUnitId: "drone-kit-a" });
  }, SLOW);

  it("lays out the same without the counter seed, and the counter seed still fits after it", async () => {
    const { vaultId } = await sandbox();
    expect((await seedSandboxSchedule({ vaultId })).lines.filter((l) => l.stopped)).toEqual([]);
    await expectPlanSeeded(vaultId);
    expect((await seedCounter({ vaultId })).lines.filter((l) => l.stopped)).toEqual([]);
    expect(await clashes()).toEqual([]);
  }, SLOW);

  it("carries the repair story: Jordan's projector back with a cracked lens, a move for Priya and a call for Diego", async () => {
    const { vaultId } = await sandbox();
    await seedCounter({ vaultId });
    await seedSandboxSchedule({ vaultId });
    const db = await getDb();
    const byEmail = async (name: string) => rentals.toRental((await db.query<Record<string, unknown>>("select * from rentals where customer_email = $1", [sandboxSeedEmail(name)]))[0]);

    const jordan = await byEmail("Jordan Lee");
    await svc.addPhoto(jordan.id, "checkin", { sample: "projector/after__cracked-lens" });
    await svc.inspect(jordan.id, undefined, { recordedOnly: true });
    const charges = awaitingCustomer((await rentals.latestAssessment(db, jordan.id))!.findings);
    await svc.sendToCustomer(jordan.id);
    await svc.respondAsCustomer(
      jordan.token,
      charges.map((f) => ({ findingId: f.id, answer: "accept" as const })),
    );
    await svc.settle(jordan.id);

    expect(await repo.repairBlockFor(db, jordan.id)).toMatchObject({ unitId: "projector-b", startDate: T(0), endDate: T(5), reason: "Replace projector lens" });
    const [priya, diego] = await Promise.all([byEmail("Priya Patel"), byEmail("Diego Alvarez")]);
    const proposals = await repo.listProposals(db, "pending");
    expect(proposals.map((p) => [p.rentalId, p.kind, p.fromUnitId, p.toUnitId, p.startDate, p.endDate, p.needsCall])).toEqual([
      // Projector A is free on Priya's dates: the counter's projector came back today and holds nothing.
      [priya.id, "reassign", "projector-b", "projector-a", null, null, false],
      // Projector A is busy on Diego's (Hannah), so the earliest dates, and a call first.
      [diego.id, "reschedule", "projector-b", "projector-b", T(6), T(8), true],
    ]);
  }, SLOW);

  it("refuses live PayPal, leaves demo mode to its own seed, and needs a saved wallet", async () => {
    slot.depositGateway = { mode: "live" };
    expect(await seedSandboxSchedule({ vaultId: "SAVED-WALLET" })).toMatchObject({ mode: "live", lines: [], skipped: expect.stringMatching(/live/) });
    slot.depositGateway = new DemoDepositGateway();
    expect(await seedSandboxSchedule({ vaultId: "SAVED-WALLET" })).toMatchObject({ mode: "demo", lines: [], skipped: expect.stringMatching(/seedDemoSchedule/) });
    const { calls } = await sandbox();
    expect(await seedSandboxSchedule({})).toMatchObject({ mode: "sandbox", lines: [], skipped: expect.stringMatching(/SEED_VAULT_ID/) });
    expect(calls()).toEqual({});
    expect(await all()).toEqual([]);
  });

  it("the nightly reset: voids the open holds, then seeds the counter and the schedule; once per day", async () => {
    const { vaultId, calls, reset } = await sandbox();
    const env = { DEMO_RESET: "true", SEED_VAULT_ID: vaultId };
    const day = new Date("2026-03-01T20:17:00Z");
    const first = await resetDemo({ now: day, env });
    expect(first).toMatchObject({ status: "reset", mode: "sandbox", released: [], seeded: { counter: SCENARIOS.length, schedule: BOOKINGS, insights: 0 } });
    expect(calls()).toEqual({ ...COUNTER_CALLS, createBookingOrder: 6 + BOOKINGS, chargeSavedWallet: 6 + BOOKINGS, holdWithSavedWallet: 5 + HOLDS });
    expect(await clashes()).toEqual([]);

    // The next night: the holds still open (three on the counter, two on the schedule) are voided first.
    reset();
    const next = await resetDemo({ now: new Date(day.getTime() + 86_400_000), env });
    if (next.status !== "reset") throw new Error(`expected a reset, got ${next.status}`);
    expect(next.released.map((r) => r.outcome)).toEqual(Array(3 + HOLDS).fill("voided"));
    const nightly = calls();
    expect(nightly).toEqual({ ...COUNTER_CALLS, release: 1 + 3 + HOLDS, createBookingOrder: 6 + BOOKINGS, chargeSavedWallet: 6 + BOOKINGS, holdWithSavedWallet: 5 + HOLDS });
    expect(Object.values(nightly).reduce((a, b) => a + b, 0)).toBe(58);
    await expectPlanSeeded(vaultId);

    // A second call that day does nothing at all.
    reset();
    expect(await resetDemo({ now: new Date(day.getTime() + 86_400_000 + 3_600_000), env })).toMatchObject({ status: "already-done" });
    expect(calls()).toEqual({});
  }, SLOW);
});
