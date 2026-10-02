// End-to-end rental scenarios in demo mode: the PayPal stand-in, an
// in-memory database, and recorded Gemini replies for the sample photos.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { firstBrokenLink } = await import("./audit");
const repo = await import("./repo");
const svc = await import("./service");
const { applyPayPalWebhook } = await import("./webhooks");

async function bookedRental(itemId = "camera-kit") {
  const { rentalId, orderId } = await svc.startBooking({
    itemId,
    name: "Maya Chen",
    email: "maya@example.com",
    startDate: todayIso(),
    endDate: addDaysIso(todayIso(), 3),
  });
  const { token } = await svc.confirmBooking(orderId);
  return { rentalId, orderId, token };
}

async function outRental(itemId = "camera-kit", before = "camera-kit/before") {
  const r = await bookedRental(itemId);
  await svc.addPhoto(r.rentalId, "checkout", { sample: before });
  await svc.holdDeposit(r.rentalId);
  await svc.acknowledgeCheckout(r.token);
  return r;
}

const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;
const assessment = async (id: string) => (await repo.latestAssessment(await getDb(), id))!;

beforeAll(async () => {
  await getDb();
});

describe("rental flow (demo mode)", () => {
  it("books: fee captured, PayPal saved, amounts computed on the server", async () => {
    const { rentalId, orderId } = await bookedRental();
    const r = await rental(rentalId);
    expect(r).toMatchObject({ status: "booked", days: 3, feeCents: 2900 * 3, depositCents: 30000 });
    expect(r.vaultId).toBeTruthy();
    // Approving twice (a double tap, a retried request) changes nothing.
    await svc.confirmBooking(orderId);
    expect((await rental(rentalId)).status).toBe("booked");
  });

  it("refuses to hold the deposit before the pickup photo exists", async () => {
    const { rentalId } = await bookedRental();
    await expect(svc.holdDeposit(rentalId)).rejects.toThrow(/pickup photo/);
  });

  it("damage path: AI finds the missing hood, customer accepts, $35 captured and $265 released", async () => {
    const { rentalId, token } = await outRental();
    expect((await rental(rentalId)).status).toBe("out");
    await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
    await svc.inspect(rentalId);

    const a = await assessment(rentalId);
    expect(a.source).toBe("replay");
    const charges = a.findings.filter((f) => f.staff === "keep");
    expect(charges.map((f) => f.price?.id)).toEqual(["missing-hood"]);

    await expect(svc.settle(rentalId)).rejects.toThrow(/Send the findings/);
    await svc.sendToCustomer(rentalId);
    await svc.respondAsCustomer(token, charges.map((f) => ({ findingId: f.id, answer: "accept" as const })));
    await svc.settle(rentalId);

    const r = await rental(rentalId);
    expect(r).toMatchObject({ status: "settled", capturedCents: 3500, releasedCents: 26500, extraCents: 0 });
  });

  it("clean path: nothing found, the whole deposit is released", async () => {
    const { rentalId } = await outRental();
    await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__same-light" });
    await svc.inspect(rentalId);
    expect((await assessment(rentalId)).findings.filter((f) => f.staff === "keep")).toHaveLength(0);
    await svc.settle(rentalId);
    expect(await rental(rentalId)).toMatchObject({ status: "settled", capturedCents: 0, releasedCents: 30000 });
  });

  it("contest path: the customer questions a charge and the counter waives it", async () => {
    const { rentalId, token } = await outRental("projector", "projector/before");
    await svc.addPhoto(rentalId, "checkin", { sample: "projector/after__missing-remote" });
    await svc.inspect(rentalId);
    const [charge] = (await assessment(rentalId)).findings.filter((f) => f.staff === "keep");
    expect(charge.price?.id).toBe("missing-remote");
    await svc.sendToCustomer(rentalId);
    await expect(svc.respondAsCustomer(token, [{ findingId: charge.id, answer: "contest" }])).rejects.toThrow(/why/);
    await svc.respondAsCustomer(token, [{ findingId: charge.id, answer: "contest", note: "The remote was in the case pocket." }]);
    await expect(svc.settle(rentalId)).rejects.toThrow(/Decide/);
    await svc.resolveContest(rentalId, charge.id, "waive");
    await svc.settle(rentalId);
    expect(await rental(rentalId)).toMatchObject({ status: "settled", capturedCents: 0, releasedCents: 20000 });
  });

  it("keeps an intact, hash-chained audit log of every step", async () => {
    const { rentalId } = await outRental();
    const events = await repo.eventsFor(await getDb(), rentalId);
    expect(events.map((e) => e.type)).toEqual(["booking.started", "booking.paid", "photo.added", "deposit.held", "checkout.acknowledged"]);
    expect(firstBrokenLink(events)).toBeNull();
    const tampered = events.map((e, i) => (i === 1 ? { ...e, data: { ...e.data, feeCents: 1 } } : e));
    expect(firstBrokenLink(tampered)).toBe(events[1].seq);
  });

  it("applies verified webhooks once, and a dispute marks the rental", async () => {
    const { rentalId, token } = await outRental();
    await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
    await svc.inspect(rentalId);
    const [charge] = (await assessment(rentalId)).findings.filter((f) => f.staff === "keep");
    await svc.sendToCustomer(rentalId);
    await svc.respondAsCustomer(token, [{ findingId: charge.id, answer: "accept" }]);
    await svc.settle(rentalId);
    const captureId = (await rental(rentalId)).settlementCaptureId!;

    const completed = { id: `WH-${rentalId}-1`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: captureId, status: "COMPLETED" } };
    expect(await applyPayPalWebhook(completed)).toBe("applied");
    expect(await applyPayPalWebhook(completed)).toBe("duplicate");
    expect(await applyPayPalWebhook({ id: "WH-unknown", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "NOPE" } })).toBe("ignored");

    const dispute = {
      id: `WH-${rentalId}-2`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", disputed_transactions: [{ seller_transaction_id: captureId }] },
    };
    expect(await applyPayPalWebhook(dispute)).toBe("applied");
    expect(await rental(rentalId)).toMatchObject({ status: "disputed", disputeId: "PP-D-1" });
    const types = (await repo.eventsFor(await getDb(), rentalId)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(["webhook.received", "dispute.opened"]);
  });
});
