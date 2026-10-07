// The nightly demo reset, in demo mode on an in-memory database. The sandbox
// cases put a scripted gateway in the PayPal slot, so the test can see which
// holds the reset voids, and when, without PayPal.
import { afterEach, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.DEMO_RESET;
delete process.env.PAYPAL_ENVIRONMENT;

const { getDb } = await import("@/lib/db/client");
const { depositGateway } = await import("@/lib/paypal");
const { PayPalError } = await import("@/lib/paypal/errors");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { SEED_NAME, SEED_PLAN } = await import("@/lib/schedule/seed");
const { SCENARIOS } = await import("@/lib/seed/plan");
const { spacedDates } = await import("@/test/dates");
const { KEPT_TABLES, lastDemoReset, resetDemo, WIPED_TABLES } = await import("./reset");

const ON = { DEMO_RESET: "true" };
const slot = globalThis as { depositGateway?: unknown };

afterEach(() => {
  // The next call builds a fresh stand-in from what demo_paypal holds now.
  slot.depositGateway = undefined;
});

async function visitorRental(opts: { hold?: boolean; name?: string } = {}) {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name: opts.name ?? "Judge One", email: "judge@example.org", ...spacedDates() });
  const { token } = await svc.confirmBooking(orderId);
  if (opts.hold) {
    await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
    await svc.holdDeposit(rentalId);
    await svc.acknowledgeCheckout(token);
  }
  return (await repo.rentalById(await getDb(), rentalId))!;
}

const rentalIds = async () => (await (await getDb()).query<{ id: string }>("select id from rentals order by id")).map((r) => r.id);
const resetRows = async () => (await getDb()).query<{ day: string; status: string }>("select day::text as day, status from demo_resets order by day");

type Release = { authorizationId: string; requestId: string; rentalStillThere: boolean };

/** A sandbox gateway that only voids: any other call fails the test. `refuse` lists holds PayPal will not void. */
function sandboxGateway(refuse: string[] = []) {
  const releases: Release[] = [];
  const release = async (authorizationId: string, requestId: string) => {
    const there = await (await getDb()).query("select id from rentals where authorization_id = $1", [authorizationId]);
    releases.push({ authorizationId, requestId, rentalStillThere: there.length === 1 });
    if (refuse.includes(authorizationId)) {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED", "debug-123", "Authorization has been previously captured.");
    }
  };
  const gateway = new Proxy({ mode: "sandbox", release } as Record<string | symbol, unknown>, {
    get: (target, prop) =>
      prop in target || prop === "then"
        ? target[prop]
        : () => {
            throw new Error(`the reset called ${String(prop)}; it may only void holds`);
          },
  });
  return { gateway, releases };
}

describe("resetDemo", () => {
  it("does nothing unless DEMO_RESET is true", async () => {
    const r = await visitorRental();
    for (const env of [{}, { DEMO_RESET: "1" }, { DEMO_RESET: "TRUE" }]) {
      expect(await resetDemo({ env })).toMatchObject({ status: "off" });
    }
    expect(await rentalIds()).toEqual([r.id]);
    expect(await resetRows()).toEqual([]);
  });

  it("refuses outright with live PayPal", async () => {
    expect(await resetDemo({ env: { ...ON, PAYPAL_ENVIRONMENT: "live" } })).toMatchObject({ status: "refused", reason: expect.stringMatching(/live PayPal/) });
    slot.depositGateway = { mode: "live" };
    expect(await resetDemo({ env: ON })).toMatchObject({ status: "refused" });
    expect((await rentalIds()).length).toBe(1);
    expect(await resetRows()).toEqual([]);
  });

  it("in the sandbox, voids the open holds through PayPal before the wipe, and never captures or refunds", async () => {
    const held = await visitorRental({ hold: true, name: "Judge Two" });
    const refused = await visitorRental({ hold: true, name: "Judge Three" });
    const booked = await visitorRental({ name: "Judge Four" });
    expect(booked.authorizationId).toBeNull();
    const { gateway, releases } = sandboxGateway([refused.authorizationId!]);
    slot.depositGateway = gateway;

    // SEED_VAULT_ID=latest could pick a visitor's wallet, so the reset does not seed with it.
    const result = await resetDemo({ now: new Date("2026-01-01T21:00:00Z"), env: { ...ON, SEED_VAULT_ID: "latest" } });

    expect(releases).toEqual([
      { authorizationId: held.authorizationId, requestId: `reset-void:${held.id}:${held.authorizationId}`, rentalStillThere: true },
      { authorizationId: refused.authorizationId, requestId: `reset-void:${refused.id}:${refused.authorizationId}`, rentalStillThere: true },
    ]);
    expect(result).toMatchObject({
      status: "reset",
      day: "2026-01-01",
      mode: "sandbox",
      deletedRentals: 4,
      released: [
        { rentalId: held.id, outcome: "voided" },
        { rentalId: refused.id, outcome: "failed", detail: "AUTHORIZATION_ALREADY_CAPTURED (PayPal debug_id debug-123)" },
      ],
      seeded: { counter: 0, schedule: 0, note: expect.stringMatching(/SEED_VAULT_ID is not set/) },
    });
    expect(await rentalIds()).toEqual([]);
    expect(await resetRows()).toEqual([{ day: "2026-01-01", status: "done" }]);
  });

  it("runs once per reset day, which starts at the reset hour, and retries a failed or abandoned day", async () => {
    const { gateway } = sandboxGateway();
    slot.depositGateway = gateway;
    const at = (when: string, env: Record<string, string> = ON) => resetDemo({ now: new Date(when), env });

    expect(await at("2026-01-01T23:59:00Z")).toMatchObject({ status: "already-done", day: "2026-01-01", state: "done" });
    // 19:59 UTC on Jan 2 is still the reset day that began at 20:00 on Jan 1.
    expect(await at("2026-01-02T19:59:00Z")).toMatchObject({ status: "already-done", day: "2026-01-01" });
    expect(await at("2026-01-02T20:17:00Z")).toMatchObject({ status: "reset", day: "2026-01-02" });
    expect(await at("2026-01-02T20:45:00Z")).toMatchObject({ status: "already-done", day: "2026-01-02" });
    // With DEMO_RESET_HOUR=3, 02:00 belongs to the day before.
    expect(await at("2026-01-05T02:00:00Z", { ...ON, DEMO_RESET_HOUR: "3" })).toMatchObject({ status: "reset", day: "2026-01-04" });

    const db = await getDb();
    await db.query("update demo_resets set status = 'failed' where day = '2026-01-02'");
    expect(await at("2026-01-02T21:17:00Z")).toMatchObject({ status: "reset", day: "2026-01-02" });
    await db.query("update demo_resets set status = 'running', started_at = now() - interval '5 minutes' where day = '2026-01-02'");
    expect(await at("2026-01-02T21:20:00Z")).toMatchObject({ status: "already-done", state: "running" });
    await db.query("update demo_resets set status = 'running', started_at = now() - interval '2 hours' where day = '2026-01-02'");
    expect(await at("2026-01-02T22:17:00Z")).toMatchObject({ status: "reset", day: "2026-01-02" });
  });

  it("in demo mode, deletes every rental and seeds the counter and the demo schedule again", async () => {
    const visitor = await visitorRental({ hold: true });
    const db = await getDb();
    await db.query("insert into webhook_events (id, event_type, verified, payload) values ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', true, '{}')");
    const staleStandIn = depositGateway();

    const result = await resetDemo({ env: ON });
    expect(result).toMatchObject({ status: "reset", mode: "demo", deletedRentals: 1, released: [] });
    if (result.status !== "reset") throw new Error("not reset");

    expect(await repo.rentalById(db, visitor.id)).toBeNull();
    const rentals = await repo.listRentals(db);
    expect(rentals).toHaveLength(result.seeded.counter + result.seeded.schedule);
    expect(result.seeded.counter).toBe(SCENARIOS.length);
    expect(result.seeded.schedule).toBeGreaterThan(SEED_PLAN.length / 2);
    const emails = new Set(rentals.map((r) => r.customerEmail));
    for (const s of SCENARIOS) expect(emails.has(s.email), s.email).toBe(true);
    expect(await db.query("select id from webhook_events")).toEqual([]);
    expect(await db.query("select name from demo_seeds")).toEqual([{ name: SEED_NAME }]);

    // The stand-in this process had cached was dropped with demo_paypal; the new one knows only the seeded holds.
    const standIn = depositGateway();
    expect(standIn).not.toBe(staleStandIn);
    await expect(standIn.getAuthorization(visitor.authorizationId!)).rejects.toThrow(/not found/i);
    const priya = rentals.find((r) => r.customerEmail === "priya.nair@example.com")!;
    expect(await standIn.getAuthorization(priya.authorizationId!)).toMatchObject({ status: "CREATED", amountCents: priya.authorizedCents });

    expect(await resetDemo({ env: ON })).toMatchObject({ status: "already-done", day: result.day });
    expect((await repo.listRentals(db)).length).toBe(rentals.length);
    expect(await lastDemoReset()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("empties every table that holds rental data and keeps the reference data", async () => {
    const db = await getDb();
    const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = current_schema() order by table_name");
    // A new table has to be added to WIPED_TABLES or KEPT_TABLES in lib/demo-reset/reset.ts.
    expect(tables.map((t) => t.table_name)).toEqual([...WIPED_TABLES, ...KEPT_TABLES].sort());
    expect((await db.query("select id from units")).length).toBe(22);
  });
});
