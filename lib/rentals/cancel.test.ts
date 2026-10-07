// Cancelling a booking before pickup, in demo mode: the PayPal stand-in and
// an in-memory database.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;

const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
const { PayPalError } = await import("@/lib/paypal/errors");
const gateway = new DemoDepositGateway();
(globalThis as { depositGateway?: unknown }).depositGateway = gateway;

const { getDb } = await import("@/lib/db/client");
const { spacedDates } = await import("@/test/dates");
const { firstBrokenLink } = await import("./audit");
const repo = await import("./repo");
const svc = await import("./service");
const refunds = await import("./refunds");
const cancel = await import("./cancel");
const { loadRentalView } = await import("./view");
const { applyPayPalWebhook } = await import("./webhooks");
const { occupantsForItem } = await import("@/lib/schedule/repo");

const HOUR = 3_600_000;
const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;
const view = async (id: string) => (await loadRentalView({ id }))!;
const events = async (id: string, type: string) => (await repo.eventsFor(await getDb(), id)).filter((e) => e.type === type);
/** `hours` before the pickup day starts (00:00 UTC on the pickup date). */
const before = (r: { startDate: string }, hours: number) => new Date(Date.parse(`${r.startDate}T00:00:00Z`) - hours * HOUR);

async function draft(itemId = "camera-kit", dates = spacedDates()) {
  const b = await svc.startBooking({ itemId, name: "Maya Chen", email: "maya@example.com", ...dates });
  const r = await rental(b.rentalId);
  return { ...b, startDate: r.startDate, token: r.token };
}

/** A paid booking of the camera kit: $87.00 for three days. */
async function booked(itemId = "camera-kit", dates = spacedDates()) {
  const d = await draft(itemId, dates);
  await svc.confirmBooking(d.orderId);
  return d;
}

/** Runs fn while recording the stand-in's calls of one kind with their request ids. */
async function counting<T, K extends "refund" | "release" | "holdWithSavedWallet" | "captureBookingOrder">(method: K, fn: () => Promise<T>) {
  const requestIds: string[] = [];
  const real = (gateway[method] as (...a: unknown[]) => Promise<unknown>).bind(gateway);
  const spy = vi.spyOn(gateway, method).mockImplementation(((...args: unknown[]) => (requestIds.push(String(args[1])), real(...args))) as never);
  try {
    return { result: await fn(), requestIds };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  await getDb();
});

describe("the renter cancels a paid booking on their page", () => {
  it("at least 24 hours before the pickup day: the whole fee back, through the refund code", async () => {
    const b = await booked();
    const { result, requestIds } = await counting("refund", () => cancel.cancelAsRenter(b.token, 8700, before(b, 30)));
    expect(requestIds).toEqual([`refund:${b.rentalId}:1`]);
    expect(result).toMatchObject({ cancelled: true, refundProblem: null, refund: { seq: 1, state: "done", amountCents: 8700, paypalStatus: "COMPLETED" } });

    const r = await rental(b.rentalId);
    expect(r).toMatchObject({ status: "cancelled", cancelledBy: "renter", cancelRefundCents: 8700, authorizationId: null });
    expect(r.cancelledAt).toBe(before(b, 30).toISOString());
    const v = await view(b.rentalId);
    expect(v.feeRefundedCents).toBe(8700);
    expect(v.refundedCents).toBe(0); // nothing a settlement took
    expect(v.refundable).toEqual([expect.objectContaining({ captureId: r.feeCaptureId, label: "the rental fee", capturedCents: 8700, leftCents: 0 })]);
    const [cancelled] = await events(b.rentalId, "booking.cancelled");
    expect(cancelled).toMatchObject({ actor: "customer", data: { by: "renter", paid: true, policyPercent: 100, refundCents: 8700, refundNumber: 1 } });
    const [issued] = await events(b.rentalId, "refund.issued");
    expect(issued).toMatchObject({ actor: "customer", data: { captureId: r.feeCaptureId, amountCents: 8700, requestId: `refund:${b.rentalId}:1` } });
    expect(firstBrokenLink(v.events)).toBeNull();
  });

  it("on the day before pickup: half, rounded down to the cent; a page showing the old amount cancels nothing", async () => {
    const b = await booked();
    const late = before(b, 12);
    await expect(cancel.cancelAsRenter(b.token, 8700, late)).rejects.toThrow(/now \$43\.50, not \$87\.00.*Nothing was cancelled/);
    expect((await rental(b.rentalId)).status).toBe("booked");
    const { result } = await counting("refund", () => cancel.cancelAsRenter(b.token, 4350, late));
    expect(result.refund).toMatchObject({ amountCents: 4350, state: "done" });
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelRefundCents: 4350 });
    expect((await view(b.rentalId)).refundable[0]).toMatchObject({ refundedCents: 4350, leftCents: 4350 });
  });

  it("on the pickup day: cancelled with nothing refunded and no refund sent", async () => {
    const b = await booked();
    const { result, requestIds } = await counting("refund", () => cancel.cancelAsRenter(b.token, 0, before(b, -2)));
    expect(requestIds).toEqual([]);
    expect(result).toEqual({ cancelled: true, refund: null, refundProblem: null });
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelRefundCents: 0 });
  });

  it("uses the terms in the booking's mandate, not today's policy", async () => {
    const b = await booked();
    const r = await rental(b.rentalId);
    expect(cancel.termsFor(r).feeRefund.map((t) => t.percent)).toEqual([100, 50]);
    // A booking from before mandates carried cancellation terms falls back to today's policy on its pickup day.
    expect(cancel.termsFor({ ...r, mandateJson: null, mandateSha256: null })).toEqual(cancel.termsFor(r));
  });

  it("refunds once when the cancel button is pressed twice at once", async () => {
    const b = await booked();
    const { result, requestIds } = await counting("refund", () =>
      Promise.all([cancel.cancelAsRenter(b.token, 8700, before(b, 48)), cancel.cancelAsRenter(b.token, 8700, before(b, 48))]),
    );
    expect(requestIds).toEqual([`refund:${b.rentalId}:1`]);
    expect(result.map((r) => r.cancelled).sort()).toEqual([false, true]);
    expect(await events(b.rentalId, "booking.cancelled")).toHaveLength(1);
    expect((await view(b.rentalId)).refunds).toHaveLength(1);
    // And again later: already cancelled, nothing sent.
    const again = await counting("refund", () => cancel.cancelAsRenter(b.token, 8700, before(b, 47)));
    expect(again).toEqual({ result: { cancelled: false, refund: null, refundProblem: null }, requestIds: [] });
  });

  it("keeps the booking cancelled when PayPal's answer to the refund is lost, and lets the counter send it again unchanged", async () => {
    const b = await booked();
    const spy = vi.spyOn(gateway, "refund").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    const result = await cancel.cancelAsRenter(b.token, 8700, before(b, 48));
    spy.mockRestore();
    expect(result).toMatchObject({ cancelled: true, refund: null, refundProblem: expect.stringMatching(/PayPal is not answering|socket hang up/) });
    const v = await view(b.rentalId);
    expect(v.rental.status).toBe("cancelled");
    expect(v.waitingRefunds).toEqual([expect.objectContaining({ seq: 1, amountCents: 8700, resendable: true })]);
    expect(v.refundable[0].leftCents).toBe(0); // reserved while PayPal's answer is unknown
    const { result: sent, requestIds } = await counting("refund", () => refunds.resendRefund(b.rentalId, 1));
    expect(requestIds).toEqual([`refund:${b.rentalId}:1`]);
    expect(sent).toMatchObject({ state: "done", amountCents: 8700 });
  });

  it("completes a lost cancellation refund from PayPal's webhook, matched on its invoice id", async () => {
    const b = await booked();
    const spy = vi.spyOn(gateway, "refund").mockRejectedValueOnce(new PayPalError(504, "GATEWAY_TIMEOUT", undefined, undefined, "timeout"));
    await cancel.cancelAsRenter(b.token, 8700, before(b, 48));
    spy.mockRestore();
    const fee = (await rental(b.rentalId)).feeCaptureId!;
    await applyPayPalWebhook({
      id: `WH-CANCEL-${b.rentalId}`,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND-CANCEL-1",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "87.00" },
        invoice_id: refunds.refundInvoiceId(b.rentalId, 1),
        links: [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${fee}`, rel: "up" }],
      },
    });
    const v = await view(b.rentalId);
    expect(v.refunds).toEqual([expect.objectContaining({ seq: 1, state: "done", refundId: "REFUND-CANCEL-1" })]);
    expect(v.feeRefundedCents).toBe(8700);
  });
});

describe("the counter cancels", () => {
  it("refunds the amount staff choose, up to the fee, with the reason the renter sees; the rest can be refunded later", async () => {
    const b = await booked();
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 8701, reason: "Projector bulb failed" })).rejects.toThrow(/At most \$87\.00 of the rental fee/);
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 2000, reason: "  " })).rejects.toThrow(/why the booking is cancelled/);
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 12.5, reason: "x" })).rejects.toThrow(/dollars and cents/);
    expect((await rental(b.rentalId)).status).toBe("booked");

    const { result, requestIds } = await counting("refund", () =>
      cancel.cancelAtCounter(b.rentalId, { refundCents: 2000, reason: "The kit you booked failed its check; $20.00 back now, the rest when we confirm" }),
    );
    expect(requestIds).toEqual([`refund:${b.rentalId}:1`]);
    expect(result.refund).toMatchObject({ amountCents: 2000, reason: "The kit you booked failed its check; $20.00 back now, the rest when we confirm" });
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelledBy: "staff", cancelReason: expect.stringMatching(/failed its check/), cancelRefundCents: 2000 });
    const [cancelled] = await events(b.rentalId, "booking.cancelled");
    expect(cancelled).toMatchObject({ actor: "staff", data: { by: "staff", refundCents: 2000, reason: expect.stringMatching(/failed its check/) } });

    // The fee is now refundable at the counter, like a settlement's charges.
    const fee = (await rental(b.rentalId)).feeCaptureId!;
    await expect(refunds.refundCharge(b.rentalId, { captureId: fee, cents: 6701, reason: "The rest", seq: 2 })).rejects.toThrow(/At most \$67\.00 is left to refund on the rental fee/);
    await refunds.refundCharge(b.rentalId, { captureId: fee, cents: 6700, reason: "The rest", seq: 2 });
    expect((await view(b.rentalId)).feeRefundedCents).toBe(8700);
  });

  it("can cancel with $0.00 refunded and sends nothing to PayPal", async () => {
    const b = await booked();
    const { requestIds } = await counting("refund", () => cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "No-show agreed with the renter" }));
    expect(requestIds).toEqual([]);
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelRefundCents: 0 });
  });

  it("is refused once the item is picked up: that is a return", async () => {
    const b = await booked();
    await svc.addPhoto(b.rentalId, "checkout", { sample: "camera-kit/before" });
    await svc.holdDeposit(b.rentalId);
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "Changed mind" })).rejects.toThrow(/this is a return, not a cancellation/);
    await expect(cancel.cancelAsRenter(b.token, 0)).rejects.toThrow(/You have picked the item up/);
    expect((await rental(b.rentalId)).status).toBe("out");
  });

  it("is refused while a PayPal dispute on the booking is open, with a pointer to the dispute desk", async () => {
    const b = await booked();
    const fee = (await rental(b.rentalId)).feeCaptureId!;
    await applyPayPalWebhook({
      id: `WH-DISPUTE-${b.rentalId}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: { dispute_id: `PP-D-${b.rentalId}`, status: "OPEN", disputed_transactions: [{ seller_transaction_id: fee }] },
    });
    const { requestIds } = await counting("refund", async () => {
      await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 8700, reason: "Sorry" })).rejects.toThrow(/open PayPal dispute.*dispute desk/);
      await expect(cancel.cancelAsRenter(b.token, 8700, before(b, 48))).rejects.toThrow(/open case with PayPal/);
    });
    expect(requestIds).toEqual([]);
    expect((await rental(b.rentalId)).status).toBe("booked");
  });

  it("releases a deposit hold if one somehow exists, with the rental's release request id", async () => {
    const b = await booked();
    const r = await rental(b.rentalId);
    const auth = await gateway.holdWithSavedWallet({ vaultId: r.vaultId!, rentalId: r.id, amountCents: 30000, description: "test" }, `stray:${r.id}`);
    await (await getDb()).query("update rentals set authorization_id = $2, authorized_cents = 30000 where id = $1", [r.id, auth.authorizationId]);
    const { requestIds } = await counting("release", () => cancel.cancelAtCounter(b.rentalId, { refundCents: 8700, reason: "Shop closed that weekend" }));
    expect(requestIds).toEqual([`release:${b.rentalId}`]);
    expect((await gateway.getAuthorization(auth.authorizationId)).status).toBe("VOIDED");
    expect(await events(b.rentalId, "deposit.released")).toEqual([expect.objectContaining({ data: expect.objectContaining({ authorizationId: auth.authorizationId, reason: "cancelled" }) })]);
  });
});

describe("cancelling an unpaid booking", () => {
  it("needs no PayPal call, and a later approval captures nothing", async () => {
    const d = await draft();
    const calls = vi.spyOn(gateway, "refund");
    const { result, requestIds } = await counting("captureBookingOrder", async () => {
      const out = await cancel.cancelAsRenter(d.token, 0);
      // The renter approves in PayPal afterwards anyway: the page, the button and the webhook all find it cancelled.
      expect(await svc.returnFromPayPal(d.token, { token: d.orderId, PayerID: "DEMOPAYER" })).toBe("approved");
      await svc.confirmBooking(d.orderId);
      return out;
    });
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
    expect(requestIds).toEqual([]);
    expect(result).toEqual({ cancelled: true, refund: null, refundProblem: null });
    expect(await rental(d.rentalId)).toMatchObject({ status: "cancelled", cancelledBy: "renter", cancelRefundCents: 0, feeCaptureId: null });
    expect(await events(d.rentalId, "booking.cancelled")).toEqual([expect.objectContaining({ data: expect.objectContaining({ paid: false, refundCents: 0 }) })]);
  });

  it("the counter can cancel one too, but not refund money that was never paid", async () => {
    const d = await draft();
    await expect(cancel.cancelAtCounter(d.rentalId, { refundCents: 100, reason: "Duplicate booking" })).rejects.toThrow(/never paid/);
    await cancel.cancelAtCounter(d.rentalId, { refundCents: 0, reason: "Duplicate booking" });
    expect(await rental(d.rentalId)).toMatchObject({ status: "cancelled", cancelledBy: "staff" });
  });

  it("refunds the whole fee when PayPal's capture lands just after the renter cancelled", async () => {
    const d = await draft();
    const real = gateway.captureBookingOrder.bind(gateway);
    const spy = vi.spyOn(gateway, "captureBookingOrder").mockImplementation(async (orderId, requestId) => {
      // The renter presses Cancel while PayPal is taking the payment.
      await cancel.cancelAsRenter(d.token, 0);
      return real(orderId, requestId);
    });
    const { requestIds } = await counting("refund", () => svc.confirmBooking(d.orderId));
    spy.mockRestore();
    expect(requestIds).toEqual([`refund:${d.rentalId}:1`]);
    const v = await view(d.rentalId);
    expect(v.rental).toMatchObject({ status: "cancelled", feeCaptureId: expect.stringMatching(/^DEMO-CAPTURE-/) });
    expect(v.feeRefundedCents).toBe(8700);
    expect(await events(d.rentalId, "booking.paid_after_cancel")).toHaveLength(1);
  });

  it("waits while PayPal is still processing the fee", async () => {
    const d = await draft();
    await (await getDb()).query("update rentals set fee_capture_id = 'PENDING-CAPTURE-1' where id = $1", [d.rentalId]);
    await expect(cancel.cancelAsRenter(d.token, 0)).rejects.toThrow(/still processing your payment/);
  });
});

describe("cancel racing the deposit hold at pickup", () => {
  async function atPickup() {
    const b = await booked();
    await svc.addPhoto(b.rentalId, "checkout", { sample: "camera-kit/before" });
    return b;
  }

  it("one of them wins when both are pressed at once", async () => {
    for (let i = 0; i < 3; i++) {
      const b = await atPickup();
      const [hold, cancelled] = await Promise.allSettled([svc.holdDeposit(b.rentalId), cancel.cancelAsRenter(b.token, null, before(b, 48))]);
      expect([hold.status, cancelled.status].filter((s) => s === "fulfilled")).toHaveLength(1);
      const r = await rental(b.rentalId);
      const v = await view(b.rentalId);
      if (hold.status === "fulfilled") {
        expect(r).toMatchObject({ status: "out", cancelledAt: null });
        expect(v.refunds).toEqual([]);
      } else {
        expect(r).toMatchObject({ status: "cancelled", authorizationId: null });
        expect(v.feeRefundedCents).toBe(8700);
      }
    }
  });

  it("a cancel pressed while PayPal is placing the hold is refused, and the hold stands", async () => {
    const b = await atPickup();
    const real = gateway.holdWithSavedWallet.bind(gateway);
    let refusal: unknown = null;
    const spy = vi.spyOn(gateway, "holdWithSavedWallet").mockImplementation(async (req, requestId) => {
      refusal = await cancel.cancelAsRenter(b.token, null, before(b, 48)).catch((err: unknown) => err);
      return real(req, requestId);
    });
    await svc.holdDeposit(b.rentalId);
    spy.mockRestore();
    expect(String(refusal)).toMatch(/started your pickup/);
    expect(await rental(b.rentalId)).toMatchObject({ status: "out", cancelledAt: null });
  });

  it("a hold pressed after the cancel is refused before PayPal is asked", async () => {
    const b = await atPickup();
    await cancel.cancelAsRenter(b.token, null, before(b, 48));
    const { requestIds } = await counting("holdWithSavedWallet", () => expect(svc.holdDeposit(b.rentalId)).rejects.toThrow(/cancelled/));
    expect(requestIds).toEqual([]);
  });

  it("a hold PayPal refused can be followed by a cancel; one whose answer was lost cannot until it is asked again", async () => {
    const b = await atPickup();
    const declined = vi.spyOn(gateway, "holdWithSavedWallet").mockRejectedValueOnce(new PayPalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "d1", "declined"));
    await expect(svc.holdDeposit(b.rentalId)).rejects.toThrow(/declined the payment method/);
    declined.mockRestore();
    expect((await rental(b.rentalId)).holdRequestedAt).toBeNull();

    const lost = vi.spyOn(gateway, "holdWithSavedWallet").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    await expect(svc.holdDeposit(b.rentalId)).rejects.toThrow();
    lost.mockRestore();
    await expect(cancel.cancelAsRenter(b.token, null, before(b, 48))).rejects.toThrow(/started your pickup/);
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "x" })).rejects.toThrow(/Press Hold again/);
    await svc.holdDeposit(b.rentalId);
    expect((await rental(b.rentalId)).status).toBe("out");
  });
});

describe("the schedule", () => {
  it("frees the cancelled booking's unit for the next customer", async () => {
    const dates = spacedDates();
    const first = await booked("projector", dates);
    await booked("projector", dates);
    await expect(booked("projector", dates)).rejects.toThrow(/Every Portable projector is booked/);
    const unit = (await rental(first.rentalId)).unitId;
    expect((await occupantsForItem(await getDb(), "projector", new Date())).some((o) => o.id === first.rentalId)).toBe(true);

    await cancel.cancelAsRenter(first.token, null, before(first, 48));
    expect((await occupantsForItem(await getDb(), "projector", new Date())).some((o) => o.id === first.rentalId)).toBe(false);
    const next = await booked("projector", dates);
    expect((await rental(next.rentalId)).unitId).toBe(unit);
  });
});
