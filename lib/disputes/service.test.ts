// The dispute desk end to end in demo mode: a settled rental is disputed,
// the counter files the evidence pack, the sandbox-style controls drive the
// case to a decision, and webhooks move the same state.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;

const { DemoDisputeApi } = await import("@/lib/paypal/demo-disputes");
const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
(globalThis as { depositGateway?: unknown }).depositGateway = new DemoDepositGateway();
const demoApi = new DemoDisputeApi();
(globalThis as { disputeApi?: unknown }).disputeApi = demoApi;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { firstBrokenLink } = await import("@/lib/rentals/audit");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { loadRentalView } = await import("@/lib/rentals/view");
const { applyPayPalWebhook } = await import("@/lib/rentals/webhooks");
const desk = await import("./service");
const disputes = await import("./repo");

/** Books, holds, inspects (missing hood) and settles with the customer accepting: $35 captured. */
async function settledRental(answer: "accept" | "contest" = "accept") {
  const { rentalId, orderId } = await svc.startBooking({
    itemId: "camera-kit",
    name: "Maya Chen",
    email: "maya@example.com",
    startDate: todayIso(),
    endDate: addDaysIso(todayIso(), 3),
  });
  const { token } = await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(rentalId);
  await svc.acknowledgeCheckout(token);
  await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
  await svc.inspect(rentalId);
  const a = (await repo.latestAssessment(await getDb(), rentalId))!;
  const charges = a.findings.filter((f) => f.staff === "keep");
  await svc.sendToCustomer(rentalId);
  await svc.respondAsCustomer(token, charges.map((f) => ({ findingId: f.id, answer, note: answer === "contest" ? "It was in the bag." : undefined })));
  if (answer === "contest") for (const f of charges) await svc.resolveContest(rentalId, f.id, "charge");
  await svc.settle(rentalId);
  return rentalId;
}

const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;
const types = async (id: string) => (await repo.eventsFor(await getDb(), id)).map((e) => e.type);
const deskFor = async (id: string) => desk.loadDisputeDesk((await loadRentalView({ id }))!);

beforeAll(async () => {
  await getDb();
});

describe("dispute desk (demo mode)", () => {
  it("runs a dispute from opening to PayPal's decision with a deterministic pack", async () => {
    const id = await settledRental();
    await desk.demoOpenDispute(id);
    expect(await rental(id)).toMatchObject({ status: "disputed" });
    let d = (await deskFor(id))!;
    expect(d.dispute).toMatchObject({ reason: "INCORRECT_AMOUNT", amountCents: 2000, status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK" });
    expect(d.requested).toEqual(["PROOF_OF_REFUND", "OTHER"]);
    expect(d.actions).toMatchObject({ provideEvidence: true, acceptClaim: ["REFUND"], adjudicate: false });
    expect(d.recommendation.action).toBe("fight");

    // Preparing twice from the same record gives the same PDF.
    const sha = await desk.prepareEvidence(id);
    expect(await desk.prepareEvidence(id)).toBe(sha);
    d = (await deskFor(id))!;
    expect(d.pack).toMatchObject({ sha256: sha, current: true });
    expect(d.pack!.narrative.source).toBe("template");

    const sent = await desk.submitEvidence(id);
    expect(sent).toBe(sha);
    d = (await deskFor(id))!;
    expect(d.dispute.status).toBe("UNDER_REVIEW");
    // Like PayPal's JSON, the stand-in leaves the deadline out under review rather than sending it empty.
    expect(Object.hasOwn(await demoApi.get(d.dispute.id), "seller_response_due_date")).toBe(false);
    expect(d).toMatchObject({ daysLeft: null, dispute: { sellerResponseDueAt: null } });
    expect(d.sent).toEqual([{ sha256: sha, at: expect.any(String), evidenceType: "OTHER", files: [`${id}-evidence.pdf`, `${id}-pickup.jpg`, `${id}-return.jpg`] }]);
    expect(d.paypal!.evidences!.at(-1)).toMatchObject({ source: "SUBMITTED_BY_SELLER", documents: [{ name: `${id}-evidence.pdf` }, { name: `${id}-pickup.jpg` }, { name: `${id}-return.jpg` }] });
    // The link is gone once PayPal has the evidence, so a second send is refused.
    await expect(desk.submitEvidence(id)).rejects.toThrow(/does not offer to send evidence/);
    // The pack sent is now part of the record, so the latest pack is out of date.
    expect(d.pack!.current).toBe(false);

    // Sandbox control: PayPal asks again; a new round can be answered.
    await desk.sandboxRequireEvidence(id);
    d = (await deskFor(id))!;
    expect(d.dispute.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(d.requested).toEqual(["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "PROOF_OF_DELIVERY_SIGNATURE"]);
    const second = await desk.submitEvidence(id);
    expect(second).not.toBe(sha);

    await desk.sandboxDecide(id, "SELLER_FAVOR");
    d = (await deskFor(id))!;
    expect(d.dispute).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
    expect(d.recommendation.action).toBe("done");
    expect(await rental(id)).toMatchObject({ status: "settled" });

    const log = await types(id);
    expect(log.filter((t) => t.startsWith("dispute."))).toEqual([
      "dispute.opened",
      "dispute.evidence_sent",
      "dispute.updated",
      "dispute.sandbox_evidence_requested",
      "dispute.updated",
      "dispute.evidence_sent",
      "dispute.updated",
      "dispute.sandbox_decided",
      "dispute.resolved",
    ]);
    expect(firstBrokenLink(await repo.eventsFor(await getDb(), id))).toBeNull();
  });

  it("refuses two submissions of the same round, even when tapped at once", async () => {
    const id = await settledRental();
    await desk.demoOpenDispute(id);
    const results = await Promise.allSettled([desk.submitEvidence(id), desk.submitEvidence(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already sent|does not offer/);
    expect((await types(id)).filter((t) => t === "dispute.evidence_sent")).toHaveLength(1);
  });

  it("recommends an offer only where PayPal allows one, and accepting resolves for the customer", async () => {
    const id = await settledRental("contest");
    await desk.demoOpenDispute(id);
    const d = (await deskFor(id))!;
    // The customer questioned the $35 charge and the counter kept it; a claim has no offer link.
    expect(d.recommendation.action).toBe("fight");
    expect(d.recommendation.reasons[0]).toContain("questioned $35.00");
    await desk.acceptClaim(id);
    expect((await deskFor(id))!.dispute).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", refundedCents: 2000 });
    await expect(desk.acceptClaim(id)).rejects.toThrow(/does not offer|already sent/);
  });
});

describe("dispute webhooks", () => {
  const resource = (id: string, captureId: string, over: Record<string, unknown>) => ({
    dispute_id: id,
    create_time: "2026-10-02T07:40:28.346Z",
    update_time: "2026-10-02T07:40:56.218Z",
    disputed_transactions: [{ seller_transaction_id: captureId, gross_amount: { currency_code: "USD", value: "35.00" } }],
    reason: "INCORRECT_AMOUNT",
    status: "OPEN",
    dispute_amount: { currency_code: "USD", value: "20.00" },
    dispute_life_cycle_stage: "CHARGEBACK",
    links: [],
    ...over,
  });

  it("opens, updates and resolves from CUSTOMER.DISPUTE.* events, ignoring stale and repeated deliveries", async () => {
    const id = await settledRental();
    const capture = (await rental(id)).settlementCaptureId!;
    const dispute = `PP-R-WH-${id}`;
    const send = (n: number, type: string, over: Record<string, unknown>) => applyPayPalWebhook({ id: `WH-${id}-${n}`, event_type: type, resource: resource(dispute, capture, over) });

    expect(await send(1, "CUSTOMER.DISPUTE.CREATED", {})).toBe("applied");
    expect(await rental(id)).toMatchObject({ status: "disputed", disputeId: dispute });
    expect(await send(1, "CUSTOMER.DISPUTE.CREATED", {})).toBe("duplicate");

    expect(await send(2, "CUSTOMER.DISPUTE.UPDATED", { status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-02T07:45:07.306Z", seller_response_due_date: "2026-10-13T06:59:59.000Z" })).toBe("applied");
    let stored = (await disputes.disputeById(await getDb(), dispute))!;
    expect(stored).toMatchObject({ status: "WAITING_FOR_SELLER_RESPONSE", sellerResponseDueAt: "2026-10-13T06:59:59.000Z", amountCents: 2000 });

    // An older delivery arriving late changes nothing but is still logged.
    expect(await send(3, "CUSTOMER.DISPUTE.UPDATED", { status: "UNDER_REVIEW", update_time: "2026-10-02T07:42:59.000Z" })).toBe("applied");
    expect((await disputes.disputeById(await getDb(), dispute))!.status).toBe("WAITING_FOR_SELLER_RESPONSE");

    // Once PayPal is reviewing, the resource has no deadline and the old one is dropped.
    expect(await send(5, "CUSTOMER.DISPUTE.UPDATED", { status: "UNDER_REVIEW", update_time: "2026-10-02T07:50:12.000Z" })).toBe("applied");
    stored = (await disputes.disputeById(await getDb(), dispute))!;
    expect(stored).toMatchObject({ status: "UNDER_REVIEW", sellerResponseDueAt: null, amountCents: 2000 });

    expect(
      await send(4, "CUSTOMER.DISPUTE.RESOLVED", {
        status: "RESOLVED",
        update_time: "2026-10-02T08:02:33.913Z",
        dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR", outcome_reason: "INELIGIBLE_BUYER_PROTECTION_POLICY" },
      }),
    ).toBe("applied");
    stored = (await disputes.disputeById(await getDb(), dispute))!;
    expect(stored).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", sellerResponseDueAt: null });
    expect(await rental(id)).toMatchObject({ status: "settled" });

    const log = (await types(id)).slice(-5);
    expect(log).toEqual(["dispute.opened", "dispute.updated", "webhook.received", "dispute.updated", "dispute.resolved"]);
  });

  it("does not change where a running rental is when its fee is disputed", async () => {
    const { rentalId, orderId } = await svc.startBooking({ itemId: "drone-kit", name: "Sam Rivera", email: "sam@example.com", startDate: todayIso(), endDate: addDaysIso(todayIso(), 2) });
    await svc.confirmBooking(orderId);
    const fee = (await rental(rentalId)).feeCaptureId!;
    expect(await applyPayPalWebhook({ id: `WH-${rentalId}-fee`, event_type: "CUSTOMER.DISPUTE.CREATED", resource: resource(`PP-R-FEE-${rentalId}`, fee, {}) })).toBe("applied");
    expect(await rental(rentalId)).toMatchObject({ status: "booked", disputeId: `PP-R-FEE-${rentalId}` });
  });
});
