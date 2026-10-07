// POST /api/jobs/reset-demo as the Render cron job calls it, in demo mode on
// an in-memory database.
import { afterAll, afterEach, describe, expect, it } from "vitest";

const saved = { ...process.env };
Object.assign(process.env, { DATABASE_URL: "memory", DEMO_MODE: "true", CRON_SECRET: "cron-test-secret", DEMO_RESET: "", PAYPAL_ENVIRONMENT: "" });
delete process.env.PAYPAL_CLIENT_ID;
afterAll(() => {
  process.env = saved;
});
afterEach(() => {
  process.env.DEMO_RESET = "";
  process.env.PAYPAL_ENVIRONMENT = "";
});

const { getDb } = await import("@/lib/db/client");
const { POST } = await import("./route");

const call = (authorization = "Bearer cron-test-secret") =>
  POST(new Request("http://localhost/api/jobs/reset-demo", { method: "POST", headers: { authorization } }));
const rentalCount = async () => (await (await getDb()).query("select id from rentals")).length;

describe("POST /api/jobs/reset-demo", () => {
  it("refuses a caller without the cron secret", async () => {
    process.env.DEMO_RESET = "true";
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(await rentalCount()).toBe(0);
  });

  it("answers that the reset is off unless DEMO_RESET is true", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "off", reason: "DEMO_RESET is not true on this service, so nothing was reset." });
    expect(await rentalCount()).toBe(0);
  });

  it("refuses with live PayPal", async () => {
    Object.assign(process.env, { DEMO_RESET: "true", PAYPAL_ENVIRONMENT: "live" });
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, status: "refused" });
    expect(await rentalCount()).toBe(0);
  });

  it("resets and seeds once, then does nothing for the rest of the day", async () => {
    process.env.DEMO_RESET = "true";
    const first = await call();
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ ok: true, status: "reset", mode: "demo", deletedRentals: 0, released: [] });
    expect(await rentalCount()).toBe(body.seeded.counter + body.seeded.schedule);

    const second = await call();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, status: "already-done", day: body.day, state: "done" });
  });
});
