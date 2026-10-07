// A plan of the dashboard's sample history that fails part way is undone:
// its deposit hold voided on the PayPal stand-in and its rows deleted, so no
// half-made rental keeps a unit, and the other plans still seed.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));
// No e-bike unit is ever free for the moved-back days: the plan fails after its hold was placed.
vi.mock("@/lib/schedule/place", async (original) => {
  const real = await original<typeof import("@/lib/schedule/place")>();
  return { ...real, freeUnitFor: vi.fn(async (db: never, itemId: string, ...rest: never[]) => (itemId === "ebike" ? null : (real.freeUnitFor as (...a: unknown[]) => unknown)(db, itemId, ...rest))) };
});
// And the drone kit's refund fails after it was settled, with its repair block placed.
vi.mock("@/lib/rentals/refunds", async (original) => {
  const real = await original<typeof import("@/lib/rentals/refunds")>();
  return { ...real, refundCharge: vi.fn(async () => Promise.reject(new Error("PayPal did not answer"))) };
});

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;

const { getDb } = await import("@/lib/db/client");
const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
const { seedInsightsHistory, INSIGHTS_PLAN } = await import("./seed");

describe("a plan that fails part way", () => {
  it("is voided and deleted, and the rest seeds", async () => {
    await getDb();
    const voided = vi.spyOn(DemoDepositGateway.prototype, "release");
    const ids = await seedInsightsHistory();
    const failed = INSIGHTS_PLAN.filter((p) => p.itemId === "ebike" || p.after === "refund").map((p) => p.name);
    expect(failed).toEqual(["Hugo Laurent", "Noah Fischer", "Sara Kim"]);
    expect(ids).toHaveLength(INSIGHTS_PLAN.length - failed.length);

    const db = await getDb();
    expect(await db.query("select id from rentals where customer_name = any($1)", [failed])).toEqual([]);
    // Nothing of theirs is left behind: no block, no event, no inspection.
    expect(await db.query("select count(*)::int as n from blocks b where not exists (select 1 from rentals r where r.id = b.rental_id)")).toEqual([{ n: 0 }]);
    expect(await db.query("select count(*)::int as n from events e where not exists (select 1 from rentals r where r.id = e.rental_id)")).toEqual([{ n: 0 }]);
    expect(await db.query("select count(*)::int as n from inspections i where not exists (select 1 from rentals r where r.id = i.rental_id)")).toEqual([{ n: 0 }]);
    // The two e-bike holds were still open when their plans failed, and were voided.
    expect(voided.mock.calls.filter(([, requestId]) => String(requestId).startsWith("seed-discard:"))).toHaveLength(2);
    // A later visit does not try again.
    expect(await seedInsightsHistory()).toEqual([]);
  });
});
