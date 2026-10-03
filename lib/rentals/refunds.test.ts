// Refunds after settlement, in demo mode: the PayPal stand-in, an in-memory
// database and recorded Gemini replies for the sample photos.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;

const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
const { DemoDisputeApi } = await import("@/lib/paypal/demo-disputes");
const { PayPalError } = await import("@/lib/paypal/errors");
const gateway = new DemoDepositGateway();
(globalThis as { depositGateway?: unknown }).depositGateway = gateway;
(globalThis as { disputeApi?: unknown }).disputeApi = new DemoDisputeApi();

const { getDb } = await import("@/lib/db/client");
const { spacedDates } = await import("@/test/dates");
const { firstBrokenLink } = await import("./audit");
const repo = await import("./repo");
const svc = await import("./service");
const refunds = await import("./refunds");
const { loadRentalView } = await import("./view");
const { applyPayPalWebhook } = await import("./webhooks");
const desk = await import("@/lib/disputes/service");
type RefundResult = import("@/lib/paypal/gateway").RefundResult;

/** Books, holds, finds the missing hood and settles with the renter accepting: $35.00 captured, $265.00 released. */
async function settledHood() {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name: "Maya Chen", email: "maya@example.com", ...spacedDates() });
  const { token } = await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(rentalId);
  await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
  await svc.inspect(rentalId);
  const charges = (await repo.latestAssessment(await getDb(), rentalId))!.findings.filter((f) => f.staff === "keep");
  await svc.sendToCustomer(rentalId);
  await svc.respondAsCustomer(token, charges.map((f) => ({ findingId: f.id, answer: "accept" as const })));
  await svc.settle(rentalId);
  const r = (await repo.rentalById(await getDb(), rentalId))!;
  expect(r).toMatchObject({ status: "settled", capturedCents: 3500 });
  return { rentalId, captureId: r.settlementCaptureId! };
}

const view = async (id: string) => (await loadRentalView({ id }))!;
const events = async (id: string, type: string) => (await repo.eventsFor(await getDb(), id)).filter((e) => e.type === type);
const refundWebhook = (eventId: string, refundId: string, captureId: string, value: string, status = "COMPLETED") => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: {
    id: refundId,
    status,
    amount: { currency_code: "USD", value },
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
      { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
    ],
  },
});

/** Runs fn while counting the stand-in's refund calls and their request ids. */
async function countingRefunds<T>(fn: () => Promise<T>): Promise<{ result: T; requestIds: string[] }> {
  const requestIds: string[] = [];
  const real = gateway.refund.bind(gateway);
  const spy = vi.spyOn(gateway, "refund").mockImplementation((req, requestId) => (requestIds.push(requestId), real(req, requestId)));
  try {
    return { result: await fn(), requestIds };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  await getDb();
});

describe("refunds at the counter (demo mode)", () => {
  it("refunds part of the settlement capture, with the reason, an audit entry and PayPal's refund id", async () => {
    const { rentalId, captureId } = await settledHood();
    const { result, requestIds } = await countingRefunds(() =>
      refunds.refundCharge(rentalId, { captureId, cents: 1000, reason: "The hood's cap turned up in the bag.", seq: 1 }),
    );
    expect(requestIds).toEqual([`refund:${rentalId}:1`]);
    expect(result).toMatchObject({ seq: 1, state: "done", amountCents: 1000, paypalStatus: "COMPLETED", refundId: expect.stringMatching(/^DEMO-REFUND-/) });

    const v = await view(rentalId);
    expect(v.refundedCents).toBe(1000);
    expect(v.refundable).toEqual([expect.objectContaining({ captureId, capturedCents: 3500, refundedCents: 1000, leftCents: 2500 })]);
    expect(v.nextRefundSeq).toBe(2);
    const [issued] = await events(rentalId, "refund.issued");
    expect(issued).toMatchObject({ actor: "staff", data: { refundId: result.refundId, captureId, amountCents: 1000, reason: "The hood's cap turned up in the bag." } });
    expect(firstBrokenLink(v.events)).toBeNull();
  });

  it("refunds the rest, then refuses anything more", async () => {
    const { rentalId, captureId } = await settledHood();
    await refunds.refundCharge(rentalId, { captureId, cents: 1000, reason: "Goodwill", seq: 1 });
    await refunds.refundCharge(rentalId, { captureId, cents: 2500, reason: "Found the hood after all", seq: 2 });
    const v = await view(rentalId);
    expect(v.refundedCents).toBe(3500);
    expect(v.refundable[0].leftCents).toBe(0);
    await expect(refunds.refundCharge(rentalId, { captureId, cents: 1, reason: "One more", seq: 3 })).rejects.toThrow(
      /Everything taken for the charge from the deposit has already been refunded/,
    );
  });

  it("refuses more than is left, a non-whole or zero amount, no reason, and captures the settlement did not make", async () => {
    const { rentalId, captureId } = await settledHood();
    const { requestIds } = await countingRefunds(async () => {
      await expect(refunds.refundCharge(rentalId, { captureId, cents: 3501, reason: "Too much", seq: 1 })).rejects.toThrow(
        /At most \$35\.00 is left to refund on the charge from the deposit/,
      );
      await expect(refunds.refundCharge(rentalId, { captureId, cents: 10.5, reason: "Half a cent", seq: 1 })).rejects.toThrow(/above \$0\.00/);
      await expect(refunds.refundCharge(rentalId, { captureId, cents: 0, reason: "Nothing", seq: 1 })).rejects.toThrow(/above \$0\.00/);
      await expect(refunds.refundCharge(rentalId, { captureId, cents: 500, reason: "   ", seq: 1 })).rejects.toThrow(/why you are refunding/);
      const fee = (await repo.rentalById(await getDb(), rentalId))!.feeCaptureId!;
      await expect(refunds.refundCharge(rentalId, { captureId: fee, cents: 500, reason: "Fee back", seq: 1 })).rejects.toThrow(/Choose a charge/);
    });
    expect(requestIds).toEqual([]);
    expect((await view(rentalId)).refunds).toEqual([]);
  });

  it("refunds once when the same form is sent twice, at once or after the first finished; a later refund gets a new id", async () => {
    const { rentalId, captureId } = await settledHood();
    const form = { captureId, cents: 700, reason: "Pressed twice", seq: 1 };
    const { result, requestIds } = await countingRefunds(async () => {
      const both = await Promise.all([refunds.refundCharge(rentalId, form), refunds.refundCharge(rentalId, form)]);
      const again = await refunds.refundCharge(rentalId, form);
      return [...both, again];
    });
    expect(new Set(result.map((r) => r.refundId)).size).toBe(1);
    // Every PayPal call for that form used the same request id, so PayPal refunds once.
    expect(new Set(requestIds)).toEqual(new Set([`refund:${rentalId}:1`]));
    expect(await events(rentalId, "refund.issued")).toHaveLength(1);
    expect((await view(rentalId)).refundedCents).toBe(700);

    // The same number with another amount is an out-of-date page, not a new refund.
    await expect(refunds.refundCharge(rentalId, { ...form, cents: 800 })).rejects.toThrow(/out of date/);
    // Skipping ahead is refused too.
    await expect(refunds.refundCharge(rentalId, { ...form, seq: 5 })).rejects.toThrow(/out of date/);

    const second = await countingRefunds(() => refunds.refundCharge(rentalId, { ...form, reason: "Second, on purpose", seq: 2 }));
    expect(second.requestIds).toEqual([`refund:${rentalId}:2`]);
    expect(second.result.refundId).not.toBe(result[0].refundId);
    expect((await view(rentalId)).refundedCents).toBe(1400);
  });

  it("is refused while a PayPal dispute on the rental is open, and points to the dispute desk", async () => {
    const { rentalId, captureId } = await settledHood();
    await desk.demoOpenDispute(rentalId);
    const { requestIds } = await countingRefunds(async () => {
      await expect(refunds.refundCharge(rentalId, { captureId, cents: 500, reason: "Sorry", seq: 1 })).rejects.toThrow(/open PayPal dispute.*dispute desk/);
    });
    expect(requestIds).toEqual([]);
  });

  it("frees the refund number when PayPal refuses, and keeps it for a retry when the answer was lost", async () => {
    const { rentalId, captureId } = await settledHood();
    const real = gateway.refund.bind(gateway);

    // PayPal refuses outright: the next try gets the next number.
    const refused = vi.spyOn(gateway, "refund").mockRejectedValueOnce(new PayPalError(422, "UNPROCESSABLE_ENTITY", "TRANSACTION_DISPUTED", "demo-debug-1", "Refund is not allowed."));
    await expect(refunds.refundCharge(rentalId, { captureId, cents: 500, reason: "First try", seq: 1 })).rejects.toThrow(/PayPal reference demo-debug-1/);
    refused.mockRestore();
    expect((await view(rentalId)).nextRefundSeq).toBe(2);
    expect((await events(rentalId, "paypal.error")).at(-1)).toMatchObject({ data: { step: "refund a charge", issue: "TRANSACTION_DISPUTED", debugId: "demo-debug-1" } });

    // The reply is lost: the number stays, and sending the same refund again reuses its request id.
    const lost = vi.spyOn(gateway, "refund").mockImplementationOnce(async (req, requestId) => {
      await real(req, requestId);
      throw new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up");
    });
    await expect(refunds.refundCharge(rentalId, { captureId, cents: 500, reason: "Second try", seq: 2 })).rejects.toThrow();
    lost.mockRestore();
    let v = await view(rentalId);
    expect(v.nextRefundSeq).toBe(2);
    expect(v.refundable[0].leftCents).toBe(3000);
    await expect(refunds.refundCharge(rentalId, { captureId, cents: 600, reason: "Changed my mind", seq: 2 })).rejects.toThrow(/still waiting for PayPal's answer/);

    const { requestIds } = await countingRefunds(() => refunds.refundCharge(rentalId, { captureId, cents: 500, reason: "Second try", seq: 2 }));
    expect(requestIds).toEqual([`refund:${rentalId}:2`]);
    v = await view(rentalId);
    expect(v.refundedCents).toBe(500);
    expect(v.refunds.map((r) => [r.seq, r.state])).toEqual([
      [1, "refused"],
      [2, "done"],
    ]);
  });
});

describe("PAYMENT.CAPTURE.REFUNDED", () => {
  it("does not count a refund the counter already recorded a second time", async () => {
    const { rentalId, captureId } = await settledHood();
    const refund = await refunds.refundCharge(rentalId, { captureId, cents: 1200, reason: "Goodwill", seq: 1 });
    const hook = refundWebhook(`WH-${rentalId}-r1`, refund.refundId!, captureId, "12.00");
    expect(await applyPayPalWebhook(hook)).toBe("applied");
    expect(await applyPayPalWebhook(hook)).toBe("duplicate");
    // PayPal may deliver the same refund under a new event id.
    expect(await applyPayPalWebhook({ ...hook, id: `WH-${rentalId}-r1-again` })).toBe("applied");
    const v = await view(rentalId);
    expect(v.refunds).toHaveLength(1);
    expect(v.refundedCents).toBe(1200);
    expect(await events(rentalId, "refund.recorded")).toHaveLength(0);
    expect(await events(rentalId, "webhook.received")).toHaveLength(2);
  });

  it("records a refund made outside the counter once, on the rental whose capture it names", async () => {
    const { rentalId, captureId } = await settledHood();
    const hook = refundWebhook(`WH-${rentalId}-outside`, "OUTSIDE-REFUND-1", captureId, "5.00");
    expect(await applyPayPalWebhook(hook)).toBe("applied");
    expect(await applyPayPalWebhook({ ...hook, id: `WH-${rentalId}-outside-again` })).toBe("applied");
    const v = await view(rentalId);
    expect(v.refunds).toEqual([expect.objectContaining({ seq: null, source: "webhook", refundId: "OUTSIDE-REFUND-1", amountCents: 500 })]);
    expect(v.refundable[0].leftCents).toBe(3000);
    // The counter's own numbering is unaffected.
    expect(v.nextRefundSeq).toBe(1);
    expect(await events(rentalId, "refund.recorded")).toHaveLength(1);
    expect(await applyPayPalWebhook(refundWebhook("WH-nobody", "OUTSIDE-REFUND-2", "NOT-OURS", "5.00"))).toBe("ignored");
  });

  it("counts a refund once when PayPal's webhook arrives before PayPal's reply is recorded", async () => {
    const { rentalId, captureId } = await settledHood();
    const real = gateway.refund.bind(gateway);
    const early = vi.spyOn(gateway, "refund").mockImplementationOnce(async (req, requestId): Promise<RefundResult> => {
      const answer = await real(req, requestId);
      await applyPayPalWebhook(refundWebhook(`WH-${rentalId}-early`, answer.refundId, captureId, "9.00"));
      return answer;
    });
    await refunds.refundCharge(rentalId, { captureId, cents: 900, reason: "Quick one", seq: 1 });
    early.mockRestore();
    const v = await view(rentalId);
    expect(v.refunds).toEqual([expect.objectContaining({ seq: 1, source: "counter", state: "done", amountCents: 900 })]);
    expect(v.refundedCents).toBe(900);
    expect(firstBrokenLink(v.events)).toBeNull();
  });
});
