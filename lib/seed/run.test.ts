// The seed in demo mode: the PayPal stand-in, an in-memory database and the
// recorded Gemini replies for the bundled sample photos.
import { describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { depositGateway } = await import("@/lib/paypal");
const repo = await import("@/lib/rentals/repo");
const { seedCounter } = await import("./run");

const byEmail = async () => {
  const db = await getDb();
  return new Map((await repo.listRentals(db)).map((r) => [r.customerEmail, r]));
};

describe("seedCounter", () => {
  it("walks six rentals to six different steps of the counter", async () => {
    const report = await seedCounter();
    expect(report.mode).toBe("demo");
    expect(report.lines.filter((l) => l.stopped)).toEqual([]);
    expect(report.lines.map((l) => l.status)).toEqual(["booked", "out", "inspecting", "customer_review", "settled", "settled"]);

    const rentals = await byEmail();
    expect(rentals.get("priya.nair@example.com")?.authorizationId).toBeTruthy();
    expect(rentals.get("alex.kim@example.com")).toMatchObject({ capturedCents: 0, releasedCents: 12000 });
    expect(rentals.get("dana.okafor@example.com")).toMatchObject({ capturedCents: 5500, releasedCents: 9500 });
  });

  it("changes nothing when run again", async () => {
    const before = await byEmail();
    const report = await seedCounter();
    expect(report.lines.every((l) => l.ran.length === 0 && !l.stopped)).toBe(true);
    const after = await byEmail();
    expect(after.size).toBe(before.size);
    for (const [email, r] of after) expect(r.updatedAt).toBe(before.get(email)?.updatedAt);
  });

  it("creates nothing against live PayPal, or in the sandbox without a saved wallet", async () => {
    const real = depositGateway();
    const slot = globalThis as { depositGateway?: unknown };
    try {
      slot.depositGateway = { mode: "live" };
      expect(await seedCounter({ vaultId: "SAVED-WALLET" })).toMatchObject({ mode: "live", lines: [] });
      slot.depositGateway = { mode: "sandbox" };
      const sandbox = await seedCounter();
      expect(sandbox.lines).toEqual([]);
      expect(sandbox.skipped).toMatch(/SEED_VAULT_ID/);
    } finally {
      slot.depositGateway = real;
    }
  });
});
