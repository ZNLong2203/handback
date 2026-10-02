// Hold renewal with a controllable clock: the demo PayPal stand-in enforces
// the sandbox's "once, from day 4 to day 29" rule.
import { describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
let clock = new Date();
const gateway = new DemoDepositGateway(() => clock);
(globalThis as { depositGateway?: unknown }).depositGateway = gateway;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("./repo");
const svc = await import("./service");
const { renewDueHolds, renewalDueAt } = await import("./jobs");

const DAY = 86_400_000;

async function heldRental(days: number) {
  const { rentalId, orderId } = await svc.startBooking({
    itemId: "drone-kit",
    name: "Sam Rivera",
    email: "sam@example.com",
    startDate: todayIso(clock),
    endDate: addDaysIso(todayIso(clock), days),
  });
  await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "drone-kit/before" });
  await svc.holdDeposit(rentalId);
  return rentalId;
}

describe("renewalDueAt", () => {
  it("waits for the day before return, never before day 4", () => {
    const at = new Date("2026-10-02T10:00:00Z");
    expect(renewalDueAt(at, "2026-10-04").toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(renewalDueAt(at, "2026-10-16").toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("renewDueHolds", () => {
  it("renews a two-week hold the day before return, once, and keeps the old id as parent", async () => {
    clock = new Date();
    const id = await heldRental(14);
    const first = (await repo.rentalById(await getDb(), id))!;

    expect((await renewDueHolds(new Date(clock.getTime() + 5 * DAY), gateway)).find((r) => r.rentalId === id)?.outcome).toBe("not-due");

    clock = new Date(clock.getTime() + 13 * DAY);
    const run = await renewDueHolds(clock, gateway);
    expect(run.find((r) => r.rentalId === id)?.outcome).toBe("renewed");
    const renewed = (await repo.rentalById(await getDb(), id))!;
    expect(renewed.parentAuthorizationId).toBe(first.authorizationId);
    expect(renewed.authorizationId).not.toBe(first.authorizationId);

    // Already renewed: later runs leave it alone.
    expect((await renewDueHolds(new Date(clock.getTime() + DAY), gateway)).find((r) => r.rentalId === id)).toBeUndefined();
    const types = (await repo.eventsFor(await getDb(), id)).map((e) => e.type);
    expect(types.at(-1)).toBe("deposit.reauthorized");
  });
});
