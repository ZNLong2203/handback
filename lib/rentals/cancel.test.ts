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
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { spacedDates } = await import("@/test/dates");
const { firstBrokenLink } = await import("./audit");
const repo = await import("./repo");
const svc = await import("./service");
const refunds = await import("./refunds");
const cancel = await import("./cancel");
const { loadRentalView } = await import("./view");
const { applyPayPalWebhook } = await import("./webhooks");
const { occupantsForItem } = await import("@/lib/schedule/repo");
const { appendEvent } = await import("./audit");
const { sealMandate } = await import("./mandate");
const { rentalStatus } = await import("@/lib/mcp/tools");
type DepositMandate = import("./mandate").DepositMandate;

const HOUR = 3_600_000;
const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;
const view = async (id: string) => (await loadRentalView({ id }))!;
const events = async (id: string, type: string) => (await repo.eventsFor(await getDb(), id)).filter((e) => e.type === type);
/** `hours` before the pickup day starts (00:00 UTC on the pickup date). */
const before = (r: { startDate: string }, hours: number) => new Date(Date.parse(`${r.startDate}T00:00:00Z`) - hours * HOUR);
/** What the renter's page showed: a paid booking and its refund, or an unpaid one. */
const paid = (refundCents: number) => ({ paid: true, refundCents });
const unpaid = { paid: false, refundCents: 0 };
const eventsOf = async (id: string) => repo.eventsFor(await getDb(), id);
const refundWebhook = (eventId: string, refundId: string, captureId: string, value: string) => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id: refundId, status: "COMPLETED", amount: { currency_code: "USD", value }, links: [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up" }] },
});
/** Makes a claim on a PayPal call look older than its life, as if its answer was lost long ago. */
const ageClaim = async (id: string, column: "capture_requested_at" | "hold_requested_at") =>
  (await getDb()).query(`update rentals set ${column} = now() - interval '10 minutes' where id = $1`, [id]);

/**
 * Dates for a booking of `itemId`, two bookings per four-day slot, so this
 * file's many bookings stay inside the shop's 120-day booking window
 * (spacedDates gives every booking its own slot).
 */
const slots = new Map<string, number>();
function datesFor(itemId: string): { startDate: string; endDate: string } {
  const n = slots.get(itemId) ?? 0;
  slots.set(itemId, n + 1);
  const startDate = addDaysIso(todayIso(), 4 * Math.floor(n / 2));
  return { startDate, endDate: addDaysIso(startDate, 3) };
}

async function draft(itemId = "camera-kit", dates = datesFor(itemId)) {
  const b = await svc.startBooking({ itemId, name: "Maya Chen", email: "maya@example.com", ...dates });
  const r = await rental(b.rentalId);
  return { ...b, startDate: r.startDate, token: r.token };
}

/** A paid booking of the camera kit: $87.00 for three days. */
async function booked(itemId = "camera-kit", dates = datesFor(itemId)) {
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
    const { result, requestIds } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(8700), before(b, 30)));
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
    await expect(cancel.cancelAsRenter(b.token, paid(8700), late)).rejects.toThrow(/now \$43\.50, not \$87\.00.*Nothing was cancelled/);
    expect((await rental(b.rentalId)).status).toBe("booked");
    const { result } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(4350), late));
    expect(result.refund).toMatchObject({ amountCents: 4350, state: "done" });
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelRefundCents: 4350 });
    expect((await view(b.rentalId)).refundable[0]).toMatchObject({ refundedCents: 4350, leftCents: 4350 });
  });

  it("on the pickup day: cancelled with nothing refunded and no refund sent", async () => {
    const b = await booked();
    const { result, requestIds } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(0), before(b, -2)));
    expect(requestIds).toEqual([]);
    expect(result).toEqual({ cancelled: true, refund: null, refundProblem: null });
    expect(await rental(b.rentalId)).toMatchObject({ status: "cancelled", cancelRefundCents: 0 });
  });

  it("uses the terms in the booking's mandate, not today's policy", async () => {
    const b = await booked();
    const r = await rental(b.rentalId);
    const fromMandate = cancel.termsFor(r, await eventsOf(r.id));
    expect(fromMandate).toMatchObject({ fromMandate: true });
    expect(fromMandate.terms.feeRefund.map((t) => t.percent)).toEqual([100, 50]);
    // A mandate that no longer matches the hash recorded at booking falls back to today's policy on its pickup day.
    expect(cancel.termsFor({ ...r, mandateJson: null, mandateSha256: null }, await eventsOf(r.id))).toEqual({ terms: fromMandate.terms, fromMandate: false });
  });

  it("refunds once when the cancel button is pressed twice at once", async () => {
    const b = await booked();
    const { result, requestIds } = await counting("refund", () =>
      Promise.all([cancel.cancelAsRenter(b.token, paid(8700), before(b, 48)), cancel.cancelAsRenter(b.token, paid(8700), before(b, 48))]),
    );
    expect(requestIds).toEqual([`refund:${b.rentalId}:1`]);
    expect(result.map((r) => r.cancelled).sort()).toEqual([false, true]);
    expect(await events(b.rentalId, "booking.cancelled")).toHaveLength(1);
    expect((await view(b.rentalId)).refunds).toHaveLength(1);
    // And again later: already cancelled, nothing sent.
    const again = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(8700), before(b, 47)));
    expect(again).toEqual({ result: { cancelled: false, refund: null, refundProblem: null }, requestIds: [] });
  });

  it("keeps the booking cancelled when PayPal's answer to the refund is lost, and lets the counter send it again unchanged", async () => {
    const b = await booked();
    const spy = vi.spyOn(gateway, "refund").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    const result = await cancel.cancelAsRenter(b.token, paid(8700), before(b, 48));
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
    await cancel.cancelAsRenter(b.token, paid(8700), before(b, 48));
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
    await expect(cancel.cancelAsRenter(b.token, paid(0))).rejects.toThrow(/You have picked the item up/);
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
      await expect(cancel.cancelAsRenter(b.token, paid(8700), before(b, 48))).rejects.toThrow(/open case with PayPal/);
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
      const out = await cancel.cancelAsRenter(d.token, unpaid);
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

  it("refuses to cancel while PayPal is taking the payment; the payment then books it, and an old page cannot cancel it for nothing", async () => {
    const d = await draft();
    const real = gateway.captureBookingOrder.bind(gateway);
    let refusal: unknown = null;
    const spy = vi.spyOn(gateway, "captureBookingOrder").mockImplementation(async (orderId, requestId) => {
      // The renter presses Cancel while PayPal is taking the payment.
      refusal = await cancel.cancelAsRenter(d.token, unpaid).catch((err: unknown) => err);
      return real(orderId, requestId);
    });
    try {
      await svc.confirmBooking(d.orderId);
    } finally {
      spy.mockRestore();
    }
    expect(String(refusal)).toMatch(/PayPal is taking your payment right now/);
    expect(await rental(d.rentalId)).toMatchObject({ status: "booked", cancelledAt: null });
    // The page the renter had open said "nothing paid": it cancels nothing now, and says why.
    await expect(cancel.cancelAsRenter(d.token, unpaid, before(d, 48))).rejects.toThrow(/Your payment went through.*gives back \$87\.00.*Nothing was cancelled/);
    expect((await rental(d.rentalId)).status).toBe("booked");
  });

  it("on the pickup day, a page drawn before payment cannot cancel the paid booking with nothing back", async () => {
    const today = todayIso();
    const d = await draft("drone-kit", { startDate: today, endDate: addDaysIso(today, 1) });
    const shown = cancel.quoteCancellation(await rental(d.rentalId), { feeLeftCents: 0, openDispute: false, events: await eventsOf(d.rentalId) }, "renter", new Date());
    expect(shown).toMatchObject({ paid: false, refundCents: 0 });
    await svc.confirmBooking(d.orderId); // another tab, or PayPal's webhook, captures before the click arrives
    await expect(cancel.cancelAsRenter(d.token, { paid: shown.paid, refundCents: shown.refundCents })).rejects.toThrow(/Your payment went through/);
    expect(await rental(d.rentalId)).toMatchObject({ status: "booked", cancelledAt: null });
    // The counter's form drawn before payment is refused the same way.
    await expect(cancel.cancelAtCounter(d.rentalId, { refundCents: 0, reason: "No-show", paid: false })).rejects.toThrow(/The fee was paid since this page was drawn/);
  });

  it("a fee capture PayPal leaves PENDING keeps the booking uncancellable until PayPal completes it", async () => {
    const d = await draft();
    const real = gateway.captureBookingOrder.bind(gateway);
    const spy = vi.spyOn(gateway, "captureBookingOrder").mockImplementation(async (orderId, requestId) => ({ ...(await real(orderId, requestId)), status: "PENDING" }));
    try {
      expect(await svc.confirmBooking(d.orderId)).toEqual({ token: d.token, pending: true });
    } finally {
      spy.mockRestore();
    }
    const r = await rental(d.rentalId);
    expect(r).toMatchObject({ status: "draft", feeCaptureId: expect.stringMatching(/^DEMO-CAPTURE-/) });
    await expect(cancel.cancelAsRenter(d.token, unpaid)).rejects.toThrow(/still processing your payment/);
    await applyPayPalWebhook({ id: `WH-COMPLETED-${d.rentalId}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: r.feeCaptureId!, status: "COMPLETED" } });
    expect((await rental(d.rentalId)).status).toBe("booked");
    const { result } = await counting("refund", () => cancel.cancelAsRenter(d.token, paid(8700), before(d, 48)));
    expect(result.refund).toMatchObject({ amountCents: 8700, state: "done" });
  });

  it("after a capture whose answer was lost, asks PayPal before cancelling: no capture, so the draft is cancelled", async () => {
    const d = await draft();
    const spy = vi.spyOn(gateway, "captureBookingOrder").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    await expect(svc.confirmBooking(d.orderId)).rejects.toThrow();
    spy.mockRestore();
    expect((await rental(d.rentalId)).captureRequestedAt).not.toBeNull();
    await expect(cancel.cancelAsRenter(d.token, unpaid)).rejects.toThrow(/taking your payment right now/);
    await ageClaim(d.rentalId, "capture_requested_at");
    const { result, requestIds } = await counting("captureBookingOrder", () => cancel.cancelAsRenter(d.token, unpaid));
    expect(requestIds).toEqual([]);
    expect(result).toMatchObject({ cancelled: true, refund: null });
    expect(await rental(d.rentalId)).toMatchObject({ status: "cancelled", feeCaptureId: null });
    expect(await events(d.rentalId, "booking.capture_checked")).toEqual([expect.objectContaining({ data: expect.objectContaining({ captured: false }) })]);
  });

  it("after a capture whose answer was lost, asks PayPal before cancelling: it went through, so the booking is paid and the old page cancels nothing", async () => {
    const d = await draft();
    const real = gateway.captureBookingOrder.bind(gateway);
    const spy = vi.spyOn(gateway, "captureBookingOrder").mockImplementationOnce(async (orderId, requestId) => {
      await real(orderId, requestId); // PayPal takes the payment; the answer is lost
      throw new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up");
    });
    await expect(svc.confirmBooking(d.orderId)).rejects.toThrow();
    spy.mockRestore();
    await ageClaim(d.rentalId, "capture_requested_at");
    await expect(cancel.cancelAsRenter(d.token, unpaid, before(d, 48))).rejects.toThrow(/Your payment went through/);
    expect(await rental(d.rentalId)).toMatchObject({ status: "booked", feeCaptureId: expect.stringMatching(/^DEMO-CAPTURE-/) });
  });

  it("refunds in full a capture that lands after a stale claim let the draft be cancelled, also when PayPal first leaves it PENDING", async () => {
    for (const status of ["COMPLETED", "PENDING"] as const) {
      const d = await draft();
      const real = gateway.captureBookingOrder.bind(gateway);
      const spy = vi.spyOn(gateway, "captureBookingOrder").mockImplementation(async (orderId, requestId) => {
        // The capture call hangs past the claim's life; meanwhile the renter cancels.
        await ageClaim(d.rentalId, "capture_requested_at");
        await cancel.cancelAsRenter(d.token, unpaid);
        return { ...(await real(orderId, requestId)), status };
      });
      const { requestIds } = await counting("refund", async () => {
        try {
          await svc.confirmBooking(d.orderId);
        } finally {
          spy.mockRestore();
        }
        const r = await rental(d.rentalId);
        expect(r).toMatchObject({ status: "cancelled", feeCaptureId: expect.stringMatching(/^DEMO-CAPTURE-/) });
        // A PENDING capture is recorded and audited, and refunded when PayPal says it completed.
        if (status === "PENDING") {
          expect(await events(d.rentalId, "booking.pending_after_cancel")).toHaveLength(1);
          expect((await view(d.rentalId)).refunds).toEqual([]);
          await applyPayPalWebhook({ id: `WH-LATE-${d.rentalId}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: r.feeCaptureId!, status: "COMPLETED", amount: { currency_code: "USD", value: "87.00" } } });
        }
      });
      expect(requestIds).toEqual([`refund:${d.rentalId}:1`]);
      expect((await view(d.rentalId)).feeRefundedCents).toBe(8700);
      expect(await events(d.rentalId, "booking.paid_after_cancel")).toHaveLength(1);
    }
  });

  it("never refunds again from a late COMPLETED webhook for a booking cancelled after it was paid", async () => {
    const b = await booked();
    await cancel.cancelAsRenter(b.token, paid(4350), before(b, 12));
    const fee = (await rental(b.rentalId)).feeCaptureId!;
    const { requestIds } = await counting("refund", () =>
      applyPayPalWebhook({ id: `WH-OLD-${b.rentalId}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: fee, status: "COMPLETED" } }),
    );
    expect(requestIds).toEqual([]);
    expect((await view(b.rentalId)).feeRefundedCents).toBe(4350);
  });

  it("waits while PayPal is still processing the fee", async () => {
    const d = await draft();
    await (await getDb()).query("update rentals set fee_capture_id = 'PENDING-CAPTURE-1' where id = $1", [d.rentalId]);
    await expect(cancel.cancelAsRenter(d.token, unpaid)).rejects.toThrow(/still processing your payment/);
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
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "x" })).rejects.toThrow(/its answer has not arrived yet/);
    await ageClaim(b.rentalId, "hold_requested_at");
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "x" })).rejects.toThrow(/Press Hold again.*invoice ID R-[0-9A-Z]{6}-deposit/);
    await svc.holdDeposit(b.rentalId);
    expect((await rental(b.rentalId)).status).toBe("out");
  });

  it("keeps the claim when a retry is refused after the first hold's answer was lost: a duplicate invoice id means that hold exists", async () => {
    const b = await atPickup();
    const real = gateway.holdWithSavedWallet.bind(gateway);
    let placed = "";
    const first = vi.spyOn(gateway, "holdWithSavedWallet").mockImplementationOnce(async (req, id) => {
      placed = (await real(req, id)).authorizationId; // PayPal places the hold; the answer is lost
      throw new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up");
    });
    await expect(svc.holdDeposit(b.rentalId)).rejects.toThrow();
    first.mockRestore();
    // Later, after PayPal forgot the request id: the fixed invoice id <rental>-deposit is refused as a duplicate.
    for (const issue of ["DUPLICATE_INVOICE_ID", "INSTRUMENT_DECLINED"]) {
      const retry = vi.spyOn(gateway, "holdWithSavedWallet").mockRejectedValueOnce(new PayPalError(422, "UNPROCESSABLE_ENTITY", issue, "d2", "refused"));
      await expect(svc.holdDeposit(b.rentalId)).rejects.toThrow();
      retry.mockRestore();
      expect((await rental(b.rentalId)).holdRequestedAt).not.toBeNull();
    }
    await expect(cancel.cancelAtCounter(b.rentalId, { refundCents: 0, reason: "No-show" })).rejects.toThrow(/answer has not arrived yet/);
    expect((await gateway.getAuthorization(placed)).status).toBe("CREATED");
    expect((await rental(b.rentalId)).status).toBe("booked");
  });

  it("lets staff confirm in PayPal that no hold is open once the claim is stale, and then cancel", async () => {
    const b = await atPickup();
    const lost = vi.spyOn(gateway, "holdWithSavedWallet").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    await expect(svc.holdDeposit(b.rentalId)).rejects.toThrow();
    lost.mockRestore();
    await expect(cancel.clearHoldClaim(b.rentalId)).rejects.toThrow(/less than two minutes ago/);
    await ageClaim(b.rentalId, "hold_requested_at");
    const r = await rental(b.rentalId);
    expect(cancel.quoteCancellation(r, { feeLeftCents: 8700, openDispute: false, events: await eventsOf(r.id) }, "staff", new Date()).holdClaimStale).toBe(true);
    expect(cancel.quoteCancellation(r, { feeLeftCents: 8700, openDispute: false, events: await eventsOf(r.id) }, "renter", new Date()).holdClaimStale).toBe(false);
    await cancel.clearHoldClaim(b.rentalId);
    expect(await events(b.rentalId, "deposit.claim_cleared")).toEqual([
      expect.objectContaining({ actor: "staff", data: expect.objectContaining({ invoiceId: `${b.rentalId}-deposit` }) }),
    ]);
    await cancel.cancelAtCounter(b.rentalId, { refundCents: 8700, reason: "We could not hand it over" });
    expect((await rental(b.rentalId)).status).toBe("cancelled");
    await expect(cancel.clearHoldClaim(b.rentalId)).rejects.toThrow(/no unanswered deposit hold/);
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

describe("terms, outside refunds and what the pages count", () => {
  /** Rewrites a booking as one made before version 2: its mandate is version 1, recorded in a fresh, intact audit chain. */
  async function asVersion1(id: string) {
    const db = await getDb();
    const r = await rental(id);
    const v1: Record<string, unknown> = { ...JSON.parse(r.mandateJson!), version: 1 };
    delete v1.cancellation;
    const sealed = sealMandate(v1 as unknown as DepositMandate);
    const old = await repo.eventsFor(db, id);
    await db.query("delete from events where rental_id = $1", [id]);
    await db.query("update rentals set mandate_json = $2, mandate_sha256 = $3 where id = $1", [id, sealed.json, sealed.sha256]);
    for (const e of old) await appendEvent(db, id, e.actor, e.type, e.type === "mandate.issued" ? { ...e.data, sha256: sealed.sha256 } : e.data);
  }

  it("cancels a booking whose intact version 1 mandate has no terms under today's policy for its pickup day", async () => {
    const b = await booked();
    await asVersion1(b.rentalId);
    const r = await rental(b.rentalId);
    expect(JSON.parse(r.mandateJson!).version).toBe(1);
    expect(cancel.termsFor(r, await eventsOf(r.id))).toMatchObject({ fromMandate: false, terms: { feeRefund: [{ percent: 100 }, { percent: 50 }] } });
    // Still a mandate the counter may hold under.
    await svc.addPhoto(b.rentalId, "checkout", { sample: "camera-kit/before" });
    const { result } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(4350), before(b, 6)));
    expect(result.refund).toMatchObject({ amountCents: 4350 });
    expect(await events(b.rentalId, "booking.cancelled")).toEqual([expect.objectContaining({ data: expect.objectContaining({ termsFrom: "policy", policyPercent: 50 }) })]);
  });

  it("ignores cancellation terms in a mandate re-sealed after booking, and applies today's policy", async () => {
    const b = await booked();
    const r = await rental(b.rentalId);
    // Someone rewrites the stored mandate to give the whole fee back until pickup, with a matching hash.
    const generous = { ...JSON.parse(r.mandateJson!), cancellation: { feeRefund: [{ before: `${r.startDate}T00:00:00.000Z`, percent: 100 }] } };
    const sealed = sealMandate(generous);
    await (await getDb()).query("update rentals set mandate_json = $2, mandate_sha256 = $3 where id = $1", [r.id, sealed.json, sealed.sha256]);
    expect(cancel.termsFor(await rental(r.id), await eventsOf(r.id)).fromMandate).toBe(false);
    const { result } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(4350), before(b, 6)));
    expect(result.refund).toMatchObject({ amountCents: 4350 });
  });

  it("refunds no more than is left when part of the fee was refunded in PayPal's dashboard before the renter cancelled", async () => {
    const b = await booked();
    const fee = (await rental(b.rentalId)).feeCaptureId!;
    await applyPayPalWebhook(refundWebhook(`WH-DASH-${b.rentalId}`, `DASH-${b.rentalId}`, fee, "60.00"));
    const r = await rental(b.rentalId);
    const shown = cancel.quoteCancellation(r, { feeLeftCents: (await view(r.id)).feeCapture!.leftCents, openDispute: false, events: await eventsOf(r.id) }, "renter", before(b, 48));
    expect(shown).toMatchObject({ refundCents: 2700, policy: { percent: 100, refundCents: 8700 } });
    const { result } = await counting("refund", () => cancel.cancelAsRenter(b.token, paid(2700), before(b, 48)));
    expect(result.refund).toMatchObject({ amountCents: 2700 });
    const v = await view(b.rentalId);
    expect(v.feeCapture).toMatchObject({ leftCents: 0 });
    expect(await events(b.rentalId, "booking.cancelled")).toEqual([expect.objectContaining({ data: expect.objectContaining({ policyRefundCents: 8700, refundCents: 2700 }) })]);
  });

  it("never counts below zero kept, and reports the refund done when a dashboard refund covers a lost one", async () => {
    const b = await booked("drone-kit", { startDate: addDaysIso(todayIso(), 3), endDate: addDaysIso(todayIso(), 5) });
    const spy = vi.spyOn(gateway, "refund").mockRejectedValueOnce(new PayPalError(0, "NETWORK_ERROR", undefined, undefined, "socket hang up"));
    await cancel.cancelAsRenter(b.token, paid(9000), before(b, 48));
    spy.mockRestore();
    const r = await rental(b.rentalId);
    const statusToken = "st_cancel_status_probe_0001";
    await (await getDb()).query("update rentals set status_token = $2 where id = $1", [r.id, statusToken]);
    expect((await rentalStatus({ statusToken })).cancellation).toMatchObject({ feeRefund: { cents: 9000 }, refundStatus: "waiting" });
    // The shop gives the money back in PayPal's dashboard instead; PayPal's webhook carries no invoice id of ours.
    await applyPayPalWebhook(refundWebhook(`WH-DASH2-${r.id}`, `DASH2-${r.id}`, r.feeCaptureId!, "90.00"));
    const v = await view(r.id);
    expect(v.feeCapture!.leftCents).toBe(0);
    expect((await rentalStatus({ statusToken })).cancellation).toMatchObject({ refundStatus: "refunded" });
    expect((await refunds.feeRefundTotals(await getDb())).get(r.id)).toEqual({ refundedCents: 9000, waitingCents: 9000 });
  });
});

describe("how far ahead", () => {
  it("opens bookings up to 120 days ahead, so every refund the policy promises stays inside PayPal's refund window", () => {
    const today = todayIso();
    expect(svc.quoteRental({ itemId: "camera-kit", startDate: addDaysIso(today, 120), endDate: addDaysIso(today, 122) }).days).toBe(2);
    expect(() => svc.quoteRental({ itemId: "camera-kit", startDate: addDaysIso(today, 121), endDate: addDaysIso(today, 123) })).toThrow(/Bookings open 120 days ahead/);
  });
});
