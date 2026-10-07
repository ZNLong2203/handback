// The owner's dashboard data: built from rentals walked through the real
// service in demo mode (PayPal stand-in, in-memory database, recorded Gemini
// replies), then checked for money that adds up. The second half feeds the
// pure builder hand-made records for the cases the demo cannot reach.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { spacedDates } = await import("@/test/dates");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { refundCharge, refundsFor } = await import("@/lib/rentals/refunds");
const { cancelAtCounter } = await import("@/lib/rentals/cancel");
const desk = await import("@/lib/disputes/service");
const { loadInsights } = await import("./load");
const { buildInsights, FLOW, holdRow } = await import("./model");
type InsightsData = import("./model").InsightsData;
type Rental = import("@/lib/rentals/types").Rental;

async function booked(name = "Maya Chen", itemId = "camera-kit") {
  const { rentalId, orderId } = await svc.startBooking({ itemId, name, email: "maya@example.com", ...spacedDates() });
  const { token } = await svc.confirmBooking(orderId);
  return { rentalId, token };
}

async function out(name?: string) {
  const r = await booked(name);
  await svc.addPhoto(r.rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(r.rentalId);
  await svc.acknowledgeCheckout(r.token);
  return r;
}

/** Missing lens hood: $35.00 kept, $265.00 released, the renter accepting or questioning it. */
async function settledDamage(answer: "accept" | "contest" = "accept", name?: string) {
  const r = await out(name);
  await svc.addPhoto(r.rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
  await svc.inspect(r.rentalId);
  const charges = (await repo.latestAssessment(await getDb(), r.rentalId))!.findings.filter((f) => f.staff === "keep");
  await svc.sendToCustomer(r.rentalId);
  await svc.respondAsCustomer(r.token, charges.map((f) => ({ findingId: f.id, answer, note: answer === "contest" ? "It was in the bag." : undefined })));
  if (answer === "contest") for (const f of charges) await svc.resolveContest(r.rentalId, f.id, "waive");
  await svc.settle(r.rentalId);
  return r.rentalId;
}

async function settledClean() {
  const r = await out("Ben Okafor");
  await svc.addPhoto(r.rentalId, "checkin", { sample: "camera-kit/after__same-light" });
  await svc.inspect(r.rentalId);
  await svc.settle(r.rentalId);
  return r.rentalId;
}

let ids: Record<string, string>;
let data: InsightsData;

beforeAll(async () => {
  await getDb();
  const damage = await settledDamage("accept", "Maya Chen");
  const refunded = await settledDamage("accept", "Lena Fischer");
  await refundCharge(refunded, { captureId: (await repo.rentalById(await getDb(), refunded))!.settlementCaptureId!, cents: 1000, reason: "Hood found in the bag", seq: 1 });
  const waived = await settledDamage("contest", "Nora Bennett");
  const clean = await settledClean();
  const cancelled = (await booked("Kai Tanaka")).rentalId;
  await cancelAtCounter(cancelled, { refundCents: 3000, reason: "Shop closed that weekend" });
  const disputedLost = await settledDamage("accept", "Ravi Shah");
  await desk.demoOpenDispute(disputedLost);
  await desk.acceptClaim(disputedLost);
  const disputedOpen = await settledDamage("accept", "Sofia Marino");
  await desk.demoOpenDispute(disputedOpen);
  const active = (await out("Grace Liu")).rentalId;
  ids = { damage, refunded, waived, clean, cancelled, disputedLost, disputedOpen, active };
  data = await loadInsights();
});

const row = (id: string) => data.rentals.find((r) => r.rental_id === id)!;
const moves = (id: string) => data.ledger.filter((m) => m.rental_id === id);

describe("the money adds up (demo mode)", () => {
  it("every settled rental: the hold is what was captured plus what was released", () => {
    for (const r of data.rentals.filter((x) => x.settled_at)) {
      expect(r.held_cents, r.rental_id).toBe(r.captured_cents + r.released_cents);
    }
    expect(row(ids.damage)).toMatchObject({ held_cents: 30000, captured_cents: 3500, released_cents: 26500, kept_cents: 3500 });
    expect(row(ids.clean)).toMatchObject({ held_cents: 30000, captured_cents: 0, released_cents: 30000, kept_cents: 0 });
  });

  it("what the shop keeps is what it captured less refunds and what a dispute gave back, never below zero", () => {
    for (const r of data.rentals) {
      expect(r.kept_cents + r.refunded_after_cents + r.dispute_returned_cents, r.rental_id).toBe(r.captured_cents + r.extra_cents);
      expect(r.kept_cents).toBeGreaterThanOrEqual(0);
    }
    expect(row(ids.refunded)).toMatchObject({ captured_cents: 3500, refunded_after_cents: 1000, kept_cents: 2500 });
    expect(row(ids.disputedLost)).toMatchObject({ captured_cents: 3500, dispute_returned_cents: 2000, kept_cents: 1500, open_disputes: 0, status: "Settled" });
    expect(row(ids.disputedOpen)).toMatchObject({ status: "Disputed", status_code: "disputed", open_disputes: 1, kept_cents: 3500 });
  });

  it("refunds never exceed what was captured, on any capture", async () => {
    const db = await getDb();
    for (const r of data.rentals) {
      const refunds = (await refundsFor(db, r.rental_id)).filter((f) => f.state === "done");
      const byCapture = new Map<string, number>();
      for (const f of refunds) byCapture.set(f.captureId, (byCapture.get(f.captureId) ?? 0) + f.amountCents);
      const rental = (await repo.rentalById(db, r.rental_id))!;
      const captured = new Map([
        [rental.feeCaptureId, rental.feeCents],
        [rental.settlementCaptureId, rental.capturedCents ?? 0],
        [rental.extraCaptureId, rental.extraCents ?? 0],
      ]);
      for (const [capture, cents] of byCapture) expect(cents).toBeLessThanOrEqual(captured.get(capture) ?? 0);
    }
  });

  it("the ledger's signed movements add up to what each rental took and gave back", () => {
    for (const r of data.rentals) {
      const net = moves(r.rental_id).reduce((s, m) => s + m.shop_net_cents, 0);
      const disputeFees = moves(r.rental_id).filter((m) => m.kind_code === "dispute_fee").reduce((s, m) => s + m.amount_cents, 0);
      const payouts = moves(r.rental_id).filter((m) => m.kind_code === "dispute_payout").reduce((s, m) => s + m.amount_cents, 0);
      const feeIn = moves(r.rental_id).some((m) => m.kind_code === "fee_capture") ? r.fee_cents : 0;
      const feeBack = r.refunded_cents - r.refunded_after_cents;
      expect(net, r.rental_id).toBe(feeIn - feeBack + r.captured_cents + r.extra_cents - r.refunded_after_cents - payouts - disputeFees);
    }
  });

  it("records one row per PayPal movement, with PayPal's ids and integer cents", async () => {
    const rental = (await repo.rentalById(await getDb(), ids.refunded))!;
    expect(moves(ids.refunded).map((m) => m.kind_code).sort()).toEqual(["deposit_hold", "fee_capture", "refund", "release", "settlement_capture"]);
    const capture = moves(ids.refunded).find((m) => m.kind_code === "settlement_capture")!;
    expect(capture).toMatchObject({ paypal_id: rental.settlementCaptureId, related_paypal_id: rental.authorizationId, amount_cents: 3500, amount_usd: 35, shop_net_cents: 3500 });
    const refund = moves(ids.refunded).find((m) => m.kind_code === "refund")!;
    expect(refund).toMatchObject({ related_paypal_id: rental.settlementCaptureId, amount_cents: 1000, shop_net_cents: -1000, status: "COMPLETED" });
    expect(refund.paypal_id).toMatch(/^DEMO-REFUND|^[A-Z0-9-]+$/);
    expect(moves(ids.clean).map((m) => m.kind_code).sort()).toEqual(["deposit_hold", "fee_capture", "void"]);
    for (const m of data.ledger) expect(Number.isSafeInteger(m.amount_cents)).toBe(true);
    expect(moves(ids.disputedLost).map((m) => m.kind_code)).toEqual(expect.arrayContaining(["dispute_hold", "dispute_payout"]));
  });

  it("a cancelled booking: the fee and the cancellation refund, no hold, no deposit flow", () => {
    expect(row(ids.cancelled)).toMatchObject({ status: "Cancelled", held_cents: 0, cancellation_refund_cents: 3000, refunded_cents: 3000, picked_up: null, pickup_photographed: null });
    expect(moves(ids.cancelled).map((m) => m.kind_code).sort()).toEqual(["cancellation_refund", "fee_capture"]);
    expect(data.flows.filter((f) => f.rental_id === ids.cancelled)).toEqual([]);
  });

  it("the deposit flow conserves money at every node", () => {
    const sum = (pred: (f: (typeof data.flows)[number]) => boolean) => data.flows.filter(pred).reduce((s, f) => s + f.amount_cents, 0);
    const heldNowOrSettled = data.rentals.filter((r) => r.picked_up && r.status_code !== "cancelled").reduce((s, r) => s + r.held_cents, 0);
    expect(sum((f) => f.from === FLOW.held)).toBe(heldNowOrSettled);
    expect(sum((f) => f.from === FLOW.kept)).toBe(sum((f) => f.to === FLOW.kept));
    expect(sum((f) => f.to === FLOW.openDispute)).toBe(3500);
    expect(sum((f) => f.to === FLOW.disputed)).toBe(2000);
    expect(sum((f) => f.to === FLOW.stillHeld)).toBe(30000);
  });

  it("findings carry the price-list entry, the staff decision, the renter's answer and the outcome", () => {
    const f = data.findings.filter((x) => x.rental_id === ids.damage && x.price_id === "missing-hood");
    expect(f).toEqual([expect.objectContaining({ price_entry: "Replace lens hood", kind: "Missing", staff_decision: "Kept", renter_answer: "Accepted", final_outcome: "Charged, renter accepted", proposed_cents: 3500, charged_cents: 3500 })]);
    const waived = data.findings.filter((x) => x.rental_id === ids.waived && x.price_id === "missing-hood");
    expect(waived).toEqual([expect.objectContaining({ renter_answer: "Questioned", final_outcome: "Waived after a question", charged_cents: 0 })]);
    expect(row(ids.waived)).toMatchObject({ captured_cents: 0, kept_cents: 0 });
  });

  it("active holds get a clock; pickups are all photographed; timings are measured", () => {
    expect(data.holds.map((h) => h.rental_id)).toEqual([ids.active]);
    expect(data.holds[0]).toMatchObject({ amount_cents: 30000, state: "In the 72-hour honor period", renewed_at: null, needs_attention: false });
    expect(data.summary).toMatchObject({ held_now_cents: 30000, pickups_photographed_share: 1, open_disputes: 1 });
    expect(data.summary.pickups).toBe(data.rentals.filter((r) => r.picked_up).length);
    const t = data.timings.find((x) => x.rental_id === ids.damage)!;
    expect(t.minutes_return_to_settled).not.toBeNull();
    expect(t.minutes_return_to_settled!).toBeGreaterThanOrEqual(0);
    expect(data.summary.median_minutes_return_to_settled).not.toBeNull();
  });

  it("names renters by first name only and carries no email address or link token", async () => {
    expect(row(ids.damage).renter).toBe("Maya");
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/@example\.com|@/);
    const tokens = (await (await getDb()).query<{ token: string }>("select token from rentals")).map((r) => r.token);
    for (const token of tokens) expect(json).not.toContain(token);
  });
});

// ─── Hand-made records ───────────────────────────────────────

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

function rental(over: Partial<Rental>): Rental {
  return {
    id: "R-TEST01",
    token: "t",
    itemId: "camera-kit",
    customerName: "Priya Patel",
    customerEmail: "priya@example.com",
    startDate: "2026-10-15",
    endDate: "2026-10-25",
    days: 10,
    feeCents: 29000,
    depositCents: 30000,
    status: "out",
    bookingOrderId: "ORDER1",
    feeCaptureId: "FEE1",
    vaultId: "VAULT1",
    payerEmail: null,
    authorizationId: "AUTH1",
    parentAuthorizationId: null,
    authorizedCents: 30000,
    authorizedAt: new Date(NOW.getTime() - 5 * DAY).toISOString(),
    authorizationExpiresAt: new Date(NOW.getTime() + 24 * DAY).toISOString(),
    settlementCaptureId: null,
    capturedCents: null,
    releasedCents: null,
    extraCaptureId: null,
    extraCents: null,
    settledAt: null,
    disputeId: null,
    approveUrl: null,
    mandateJson: null,
    mandateSha256: null,
    statusToken: null,
    createdAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    updatedAt: NOW.toISOString(),
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    cancelRefundCents: null,
    holdRequestedAt: null,
    captureRequestedAt: null,
    ...over,
  };
}

const build = (rentals: Rental[], extra: Partial<Parameters<typeof buildInsights>[0]> = {}) =>
  buildInsights({ now: NOW, rentals, refunds: [], disputes: [], assessments: [], photos: [], units: {}, ...extra });

describe("hold clock", () => {
  it("schedules the renewal for the day before return, never before 72 hours", () => {
    const h = holdRow(rental({}), NOW)!;
    expect(h.state).toBe("Past 72 hours, renewal scheduled");
    expect(h.honor_ends_at).toBe(new Date(NOW.getTime() - 2 * DAY).toISOString());
    expect(h.renewal_due_at).toBe("2026-10-24T00:00:00.000Z");
    expect(h.needs_attention).toBe(false);
    const short = holdRow(rental({ endDate: "2026-10-16", authorizedAt: new Date(NOW.getTime() - 1 * DAY).toISOString() }), NOW)!;
    expect(short.state).toBe("In the 72-hour honor period");
    // Due back long ago: the renewal is due from 72 hours, and the overdue return needs attention.
    expect(short.renewal_due_at).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
    expect(short.attention).toMatch(/due back on 2026-10-16/);
  });

  it("a renewed hold keeps the first hold's expiry and counts from the first hold", () => {
    const firstHold = NOW.getTime() - 9 * DAY;
    const h = holdRow(
      rental({
        authorizationId: "AUTH2",
        parentAuthorizationId: "AUTH1",
        authorizedAt: new Date(NOW.getTime() - 1 * DAY).toISOString(),
        authorizationExpiresAt: new Date(firstHold + 29 * DAY).toISOString(),
      }),
      NOW,
    )!;
    expect(h).toMatchObject({ state: "Renewed, keeps the first expiry", original_authorization_id: "AUTH1", authorization_id: "AUTH2", held_at: new Date(firstHold).toISOString(), days_left: 20 });
    const ledger = build([rental({ authorizationId: "AUTH2", parentAuthorizationId: "AUTH1", authorizationExpiresAt: new Date(firstHold + 29 * DAY).toISOString() })]).ledger;
    expect(ledger.map((m) => [m.kind_code, m.paypal_id])).toEqual(expect.arrayContaining([["deposit_hold", "AUTH1"], ["hold_renewal", "AUTH2"]]));
  });

  it("flags a hold close to expiry and a renewal the job missed", () => {
    const old = holdRow(
      rental({ endDate: "2026-11-30", authorizedAt: new Date(NOW.getTime() - 27 * DAY).toISOString(), authorizationExpiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString() }),
      NOW,
    )!;
    expect(old.needs_attention).toBe(true);
    expect(old.attention).toMatch(/expires in 2 days/);
    const missed = holdRow(rental({ endDate: "2026-10-20" }), NOW)!;
    expect(missed.state).toBe("Renewal due now");
    expect(missed.attention).toMatch(/Renewal was due/);
  });

  it("ignores rentals without a running hold", () => {
    expect(holdRow(rental({ status: "booked", authorizationId: null, authorizedCents: null, authorizedAt: null }), NOW)).toBeNull();
    expect(holdRow(rental({ status: "settled" }), NOW)).toBeNull();
  });
});

describe("edge cases", () => {
  const settled = rental({
    status: "settled",
    settlementCaptureId: "CAP1",
    capturedCents: 5000,
    releasedCents: 25000,
    settledAt: NOW.toISOString(),
  });

  it("counts money PayPal reported both by refund webhook and as a dispute's outcome once", () => {
    const d = build([settled], {
      refunds: [{ id: "f1", rentalId: settled.id, seq: null, captureId: "CAP1", amountCents: 2000, state: "done", refundId: "RF1", paypalStatus: "COMPLETED", source: "webhook", createdAt: NOW.toISOString() }],
      disputes: [{ id: "PP-D-1", rentalId: settled.id, transactionId: "CAP1", reason: "INCORRECT_AMOUNT", status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", amountCents: 2000, refundedCents: 2000, openedAt: NOW.toISOString(), fundMovements: [] }],
    });
    expect(d.rentals[0]).toMatchObject({ kept_cents: 3000, dispute_returned_cents: 2000, refunded_after_cents: 0 });
  });

  it("a refund waiting for PayPal's answer is listed but moves no money yet; a refused one is left out", () => {
    const d = build([settled], {
      refunds: [
        { id: "f1", rentalId: settled.id, seq: 1, captureId: "CAP1", amountCents: 1000, state: "requested", refundId: null, paypalStatus: null, source: "counter", createdAt: NOW.toISOString() },
        { id: "f2", rentalId: settled.id, seq: 2, captureId: "CAP1", amountCents: 500, state: "refused", refundId: null, paypalStatus: null, source: "counter", createdAt: NOW.toISOString() },
      ],
    });
    const refunds = d.ledger.filter((m) => m.kind_code === "refund");
    expect(refunds).toEqual([expect.objectContaining({ amount_cents: 1000, shop_net_cents: 0, status: "Sent, no answer from PayPal yet" })]);
    expect(d.rentals[0].kept_cents).toBe(5000);
  });

  it("a booking PayPal declined took no fee", () => {
    const d = build([rental({ status: "cancelled", cancelledAt: null, authorizationId: null, authorizedCents: null, authorizedAt: null })]);
    expect(d.ledger).toEqual([]);
  });

  it("a charge above the deposit is kept with the capture and flows into what was captured", () => {
    const d = build([
      rental({ status: "settled", settlementCaptureId: "CAP1", capturedCents: 30000, releasedCents: 0, extraCaptureId: "EXTRA1", extraCents: 4500, settledAt: NOW.toISOString() }),
    ]);
    expect(d.rentals[0]).toMatchObject({ kept_cents: 34500, released_cents: 0 });
    expect(d.ledger.map((m) => m.kind_code).sort()).toEqual(["deposit_hold", "extra_charge", "fee_capture", "settlement_capture"]);
    expect(d.flows).toEqual(expect.arrayContaining([expect.objectContaining({ from: FLOW.above, to: FLOW.kept, amount_cents: 4500 })]));
  });
});
