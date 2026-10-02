// Which unit the counter hands over at pickup, and when it should stop and
// look at the schedule first. Demo mode, in-memory database.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const rentals = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { applyPayPalWebhook } = await import("@/lib/rentals/webhooks");
const repo = await import("./repo");
const { handovers } = await import("./handover");

const T = (n: number) => addDaysIso(todayIso(), n);
const rental = async (id: string) => (await rentals.rentalById(await getDb(), id))!;
const handover = async (id: string) => (await handovers([await rental(id)])).get(id);

async function paidBooking(name: string, from: number, to: number) {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "projector", name, email: "someone@example.com", startDate: T(from), endDate: T(to) });
  await svc.confirmBooking(orderId);
  return rentalId;
}

let ann = "";
let bob = "";

beforeAll(async () => {
  ann = await paidBooking("Ann Out", 0, 2);
  await svc.addPhoto(ann, "checkout", { sample: "projector/before" });
  await svc.holdDeposit(ann);
  bob = await paidBooking("Bob Booked", 0, 2);
});

describe("the unit to hand over", () => {
  it("names the unit each rental was given, with nothing to check when it is ready", async () => {
    expect(await handover(ann)).toEqual({ unitId: "projector-a", label: "Projector A", warning: null });
    expect(await handover(bob)).toEqual({ unitId: "projector-b", label: "Projector B", warning: null });
  });

  it("warns when the unit is blocked during the rental", async () => {
    await repo.insertBlock(await getDb(), {
      id: "B-HANDOVER1",
      unitId: "projector-b",
      startDate: T(1),
      endDate: T(1),
      kind: "maintenance",
      reason: "Bulb",
      rentalId: null,
      createdBy: "staff",
    });
    expect((await handover(bob))?.warning).toMatch(/^Projector B is blocked .* \(Bulb\)\. Move this booking to another unit on the schedule/);
  });

  it("warns when another customer is overdue with the unit, even after opening a PayPal dispute", async () => {
    // Ann was due back yesterday and still has Projector A, so the schedule gives it to Cat for today.
    await (await getDb()).query("update rentals set start_date = $2, end_date = $3 where id = $1", [ann, T(-4), T(-1)]);
    const cat = await paidBooking("Cat Next", 0, 1);
    expect((await rental(cat)).unitId).toBe("projector-a");
    expect((await handover(cat))?.warning).toMatch(/^Projector A is still out with Ann Out, due back /);

    await applyPayPalWebhook({
      id: "WH-HANDOVER-1",
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: { dispute_id: "PP-D-HANDOVER", disputed_transactions: [{ seller_transaction_id: (await rental(ann)).feeCaptureId! }] },
    });
    expect((await rental(ann)).status).toBe("disputed");
    expect((await handover(cat))?.warning).toMatch(/^Projector A is still out with Ann Out/);
  });
});
