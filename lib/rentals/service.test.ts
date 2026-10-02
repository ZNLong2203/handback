// End-to-end rental scenarios in demo mode: the PayPal stand-in, an
// in-memory database, and recorded Gemini replies for the sample photos.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { firstBrokenLink } = await import("./audit");
const { openMandate, sealMandate } = await import("./mandate");
type DepositMandate = import("./mandate").DepositMandate;
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
    expect(events.map((e) => e.type)).toEqual([
      "mandate.issued",
      "booking.started",
      "booking.paid",
      "photo.added",
      "deposit.held",
      "checkout.acknowledged",
    ]);
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

describe("deposit mandate", () => {
  /**
   * Replaces the stored mandate with a re-sealed one. With `asIssued`, the
   * audit entry from booking is changed to match too, which stands for a
   * mandate genuinely issued on other terms; without it, the row was edited
   * after the fact.
   */
  async function replaceMandate(rentalId: string, change: (m: DepositMandate) => DepositMandate, asIssued = false) {
    const r = await rental(rentalId);
    const { json, sha256 } = sealMandate(change(openMandate(r.mandateJson!, r.mandateSha256!)!.mandate));
    const db = await getDb();
    await db.query("update rentals set mandate_json = $2, mandate_sha256 = $3 where id = $1", [rentalId, json, sha256]);
    if (asIssued) {
      await db.query("update events set data = jsonb_set(data, '{sha256}', to_jsonb($2::text)) where rental_id = $1 and type = 'mandate.issued'", [rentalId, sha256]);
    }
  }

  /** A rental whose renter has accepted the $35 missing-hood charge, ready to settle. */
  async function acceptedHood() {
    const { rentalId, token } = await outRental();
    await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
    await svc.inspect(rentalId);
    const charges = (await assessment(rentalId)).findings.filter((f) => f.staff === "keep");
    await svc.sendToCustomer(rentalId);
    await svc.respondAsCustomer(token, charges.map((f) => ({ findingId: f.id, answer: "accept" as const })));
    return rentalId;
  }

  it("is issued with every web booking, stored as hashed canonical JSON and recorded in the audit chain", async () => {
    const { rentalId } = await bookedRental();
    const r = await rental(rentalId);
    const opened = openMandate(r.mandateJson!, r.mandateSha256!);
    expect(opened?.intact).toBe(true);
    expect(opened?.mandate).toMatchObject({
      rentalId,
      issuedTo: { party: "renter" },
      renter: { name: "Maya Chen", email: "maya@example.com" },
      feeCents: 8700,
      hold: { maxCents: 30000, starts: "at_pickup" },
    });
    const [issued, started] = await repo.eventsFor(await getDb(), rentalId);
    expect(issued).toMatchObject({ type: "mandate.issued", actor: "system", data: { sha256: r.mandateSha256, issuedTo: "renter" } });
    expect(started).toMatchObject({ type: "booking.started", actor: "customer" });
  });

  it("names the assistant when one books for the renter, and keeps the approval link", async () => {
    const booking = await svc.startBooking(
      { itemId: "drone-kit", name: "Sam Rivera", email: "sam@example.com", startDate: todayIso(), endDate: addDaysIso(todayIso(), 2) },
      { party: "assistant", assistant: "Claude" },
    );
    expect(booking.mandate.issuedTo).toEqual({ party: "assistant", assistant: "Claude", actingFor: "Sam Rivera <sam@example.com>" });
    expect(booking.approveUrl).toMatch(new RegExp(`/demo/paypal\\?token=${booking.orderId}$`));
    const r = await rental(booking.rentalId);
    expect(r).toMatchObject({ status: "draft", approveUrl: booking.approveUrl, mandateSha256: booking.mandateSha256 });
    const types = (await repo.eventsFor(await getDb(), booking.rentalId)).map((e) => [e.actor, e.type]);
    expect(types).toEqual([
      ["system", "mandate.issued"],
      ["assistant", "booking.started"],
    ]);
  });

  it("blocks a charge priced differently from the mandate the renter approved", async () => {
    const rentalId = await acceptedHood();
    // The renter approved a $20 hood; the price list now says $35.
    await replaceMandate(rentalId, (m) => ({ ...m, priceList: m.priceList.map((p) => (p.id === "missing-hood" ? { ...p, cents: 2000 } : p)) }), true);
    await expect(svc.settle(rentalId)).rejects.toThrow(/Replace lens hood at \$35\.00 is not on the price list the renter agreed to/);
    expect(await rental(rentalId)).toMatchObject({ status: "responded", settlementCaptureId: null });
    expect((await repo.eventsFor(await getDb(), rentalId)).at(-1)).toMatchObject({ type: "mandate.refused", data: { step: "settle the deposit" } });
  });

  it("charges nothing when the mandate was edited, re-sealed, swapped or removed after booking", async () => {
    const db = await getDb();
    const tamperings: [string, (rentalId: string) => Promise<void>][] = [
      ["edited without re-hashing", async (id) => {
        const r = await rental(id);
        await db.query("update rentals set mandate_json = $2 where id = $1", [id, r.mandateJson!.replace('"cents":3500', '"cents":350')]);
      }],
      ["re-sealed with new terms", (id) => replaceMandate(id, (m) => ({ ...m, hold: { ...m.hold, maxCents: 99900 } }))],
      ["swapped for another rental's", async (id) => {
        const other = await rental((await bookedRental()).rentalId);
        await db.query("update rentals set mandate_json = $2, mandate_sha256 = $3 where id = $1", [id, other.mandateJson, other.mandateSha256]);
      }],
      ["removed", (id) => db.query("update rentals set mandate_json = null, mandate_sha256 = null where id = $1", [id]).then(() => {})],
    ];
    for (const [what, tamper] of tamperings) {
      const rentalId = await acceptedHood();
      await tamper(rentalId);
      await expect(svc.settle(rentalId), what).rejects.toThrow(/not the one recorded when the booking started/);
      expect(await rental(rentalId), what).toMatchObject({ status: "responded", settlementCaptureId: null });
    }
  });

  it("never needs the mandate to give a deposit back", async () => {
    const { rentalId } = await outRental();
    await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__same-light" });
    await svc.inspect(rentalId);
    await (await getDb()).query("update rentals set mandate_sha256 = $2 where id = $1", [rentalId, "0".repeat(64)]);
    await svc.settle(rentalId);
    expect(await rental(rentalId)).toMatchObject({ status: "settled", capturedCents: 0, releasedCents: 30000 });
  });

  it("will not hold a deposit once the mandate has ended", async () => {
    const { rentalId } = await bookedRental();
    await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
    await replaceMandate(rentalId, (m) => ({ ...m, expiresAt: new Date(Date.now() - 1000).toISOString() }), true);
    await expect(svc.holdDeposit(rentalId)).rejects.toThrow(/mandate ended/);
    expect((await rental(rentalId)).status).toBe("booked");
  });
});

describe("approving by redirect", () => {
  async function draft() {
    return svc.startBooking(
      { itemId: "drone-kit", name: "Sam Rivera", email: "sam@example.com", startDate: todayIso(), endDate: addDaysIso(todayIso(), 2) },
      { party: "assistant", assistant: null },
    );
  }

  it("captures the booking when PayPal sends the renter back, once, however often the page loads", async () => {
    const b = await draft();
    expect(await svc.returnFromPayPal(b.token, {})).toBe("none");
    expect(await svc.returnFromPayPal(b.token, { token: b.orderId, PayerID: "DEMOPAYER" })).toBe("approved");
    expect(await rental(b.rentalId)).toMatchObject({ status: "booked", feeCents: 9000 });
    expect(await svc.returnFromPayPal(b.token, { token: b.orderId, PayerID: "DEMOPAYER" })).toBe("approved");
    const paid = (await repo.eventsFor(await getDb(), b.rentalId)).filter((e) => e.type === "booking.paid");
    expect(paid).toHaveLength(1);
  });

  it("books once when two returns arrive at the same time", async () => {
    const b = await draft();
    const query = { token: b.orderId, PayerID: "DEMOPAYER" };
    expect(await Promise.all([svc.returnFromPayPal(b.token, query), svc.returnFromPayPal(b.token, query)])).toEqual(["approved", "approved"]);
    const paid = (await repo.eventsFor(await getDb(), b.rentalId)).filter((e) => e.type === "booking.paid");
    expect(paid).toHaveLength(1);
  });

  it("shows the renter PayPal's refusal, keeps the booking unpaid, and still books on the real approval", async () => {
    const b = await draft();
    // The refusal comes from another copy of the errors module, as it does in
    // Next.js when the MCP route created the shared gateway (see PayPalError.is).
    vi.resetModules();
    const { PayPalError: OtherCopy } = await import("@/lib/paypal/errors");
    const shared = globalThis as { depositGateway?: object };
    const real = shared.depositGateway!;
    shared.depositGateway = Object.assign(Object.create(real), {
      captureBookingOrder: async () => {
        throw new OtherCopy(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "f73514956e4a5", "Payer has not yet approved the Order for payment.");
      },
    });
    try {
      expect(await svc.returnFromPayPal(b.token, { token: b.orderId, PayerID: "NOTAPPROVED1" })).toBe("failed");
    } finally {
      shared.depositGateway = real;
    }
    expect((await rental(b.rentalId)).status).toBe("draft");
    const events = await repo.eventsFor(await getDb(), b.rentalId);
    expect(events.at(-1)).toMatchObject({ type: "paypal.error", data: { issue: "ORDER_NOT_APPROVED", debugId: "f73514956e4a5" } });
    // The page explains it from the audit log after moving off PayPal's URL.
    expect(svc.captureRefusal(events)).toBe(
      "PayPal has no approval for this payment yet, so nothing was charged. Approve it in PayPal first (PayPal reference f73514956e4a5).",
    );

    expect(await svc.returnFromPayPal(b.token, { token: b.orderId, PayerID: "DEMOPAYER" })).toBe("approved");
    expect((await rental(b.rentalId)).status).toBe("booked");
  });

  it("reports a cancel, and ignores a return for some other order or without a payer", async () => {
    const b = await draft();
    expect(await svc.returnFromPayPal(b.token, { paypal: "cancelled", token: b.orderId })).toBe("cancelled");
    expect(await svc.returnFromPayPal(b.token, { token: "SOME-OTHER-ORDER", PayerID: "X" })).toBe("none");
    expect(await svc.returnFromPayPal(b.token, { token: b.orderId })).toBe("none");
    expect(await svc.returnFromPayPal("no-such-token", { token: b.orderId, PayerID: "X" })).toBe("none");
    expect((await rental(b.rentalId)).status).toBe("draft");
  });
});
