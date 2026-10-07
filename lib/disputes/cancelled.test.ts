// A PayPal dispute on the fee of a booking cancelled before pickup, in demo
// mode: the evidence pack, PayPal's notes and the desk's advice must tell
// the cancellation, never a pickup or a return that did not happen.
import { PDFDocument } from "pdf-lib";
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
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const cancel = await import("@/lib/rentals/cancel");
const { loadRentalView } = await import("@/lib/rentals/view");
const desk = await import("./service");
const { recordDispute } = await import("./record");
const { factList } = await import("./facts");
const { narrativePrompt, narrativeProblems, templateNarrative } = await import("./narrative");
const { paypalNotes, renderEvidencePdf, sha256Hex } = await import("./evidence");

const HOUR = 3_600_000;
let slot = 0;

/** A camera kit booked and paid ($87.00), then cancelled at `hoursBefore` the pickup day, by the renter or the counter. */
async function cancelledBooking(by: "renter" | "staff", hoursBefore: number) {
  const startDate = addDaysIso(todayIso(), 2 + 4 * slot++);
  const b = await svc.startBooking({ itemId: "camera-kit", name: "Maya Chen", email: "maya@example.com", startDate, endDate: addDaysIso(startDate, 3) });
  await svc.confirmBooking(b.orderId);
  const r = (await repo.rentalById(await getDb(), b.rentalId))!;
  const at = new Date(Date.parse(`${startDate}T00:00:00Z`) - hoursBefore * HOUR);
  if (by === "renter") {
    const shown = cancel.quoteCancellation(r, { feeLeftCents: 8700, openDispute: false, events: await repo.eventsFor(await getDb(), r.id) }, "renter", at);
    await cancel.cancelAsRenter(r.token, { paid: true, refundCents: shown.refundCents }, at);
  } else {
    await cancel.cancelAtCounter(r.id, { refundCents: 2000, reason: "The kit failed its check", paid: true }, at);
  }
  return (await repo.rentalById(await getDb(), b.rentalId))!;
}

/** The customer disputes what the shop kept of the fee, as in PayPal's Resolution Center. */
async function disputeFee(rentalId: string, disputedCents: number) {
  const r = (await repo.rentalById(await getDb(), rentalId))!;
  const d = await demoApi.open({
    sellerTransactionId: r.feeCaptureId!,
    transactionCents: r.feeCents,
    disputedCents,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    note: "I cancelled and never got the camera.",
    custom: r.id,
    invoiceNumber: `${r.id}-fee`,
  });
  await (await getDb()).tx((tx) => recordDispute(tx, rentalId, d, "demo"));
  return d.dispute_id;
}

const deskFor = async (id: string) => (await desk.loadDisputeDesk((await loadRentalView({ id }))!))!;
const packFor = async (sha: string) =>
  (await (await getDb()).query<{ facts: import("./facts").EvidenceFacts; narrative: import("./narrative").Narrative; bytes: Uint8Array }>("select facts, narrative, bytes from evidence_packs where sha256 = $1", [sha]))[0];

beforeAll(async () => {
  await getDb();
});

describe("a dispute on a cancelled booking's fee", () => {
  it("builds a pack about the booking, the terms the renter approved and the cancellation, with no pickup or return", async () => {
    const r = await cancelledBooking("renter", 12); // the day before pickup: half back
    expect(r).toMatchObject({ status: "cancelled", cancelRefundCents: 4350 });
    await disputeFee(r.id, 4350);
    const v = (await loadRentalView({ id: r.id }))!;
    expect(v.rental.status).toBe("cancelled");

    const sha = await desk.prepareEvidence(r.id);
    const pack = await packFor(sha);
    expect(pack.facts.cancellation).toMatchObject({
      by: "renter",
      termsFrom: "mandate",
      mandateSha256: r.mandateSha256,
      policyPercent: 50,
      refundCents: 4350,
      terms: [{ percent: 100 }, { percent: 50 }],
    });
    const facts = factList(pack.facts);
    const text = facts.map((f) => f.text).join(" ");
    expect(facts.find((f) => f.id === "rental")!.text).toMatch(/cancelled before pickup, so the item never left the shop/);
    expect(text).not.toMatch(/picked up 20|due back|return photo|Settled/);
    expect(facts.find((f) => f.id === "cancellation")!.text).toMatch(
      /Maya Chen cancelled the booking at .* UTC, before pickup; no deposit was held\. The cancellation terms were fixed in the deposit mandate the customer approved in PayPal at booking \(SHA-256 [0-9a-f]{64}\): 100% of the fee back if cancelled before .*; 50% .*; nothing from then on\. Cancelling then gave back 50% of the fee, \$43\.50\. After the refunds in this pack, the shop kept \$43\.50 of the \$87\.00 fee\./,
    );

    // The summary passes the same fact check Gemini's would, and the prompt asks for this order of events.
    expect(pack.narrative.source).toBe("template");
    expect(narrativeProblems(pack.narrative, facts)).toEqual([]);
    expect(pack.narrative.paragraphs.map((p) => p.text).join(" ")).not.toMatch(/pickup photo|return photo|captured .* of the deposit/);
    expect(narrativePrompt(facts)).toMatch(/cancellation terms and how the customer agreed to them/);

    // What PayPal reads with the files.
    const notes = paypalNotes(pack.facts, pack.narrative, sha);
    expect(notes).toMatch(/cancelled .* before pickup: the item never left the shop and no deposit was held/);
    expect(notes).toMatch(/the cancellation terms the customer approved in PayPal at booking \(in the deposit mandate\)/);
    expect(notes).not.toMatch(/pickup and return photos|PayPal settlement|two original photos/);

    // One page, no photos, and the same bytes from the same facts.
    const doc = await PDFDocument.load(pack.bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getSubject()).toBe("Booking and cancellation record for a PayPal dispute");
    expect(sha256Hex(await renderEvidencePdf(structuredClone(pack.facts), structuredClone(pack.narrative), { pickup: null, returned: null }))).toBe(sha);
    expect(await desk.prepareEvidence(r.id)).toBe(sha);
  });

  it("sends the pack alone, since there are no photos", async () => {
    const r = await cancelledBooking("renter", 12);
    await disputeFee(r.id, 4350);
    await desk.submitEvidence(r.id);
    const sent = (await repo.eventsFor(await getDb(), r.id)).filter((e) => e.type === "dispute.evidence_sent");
    expect(sent).toEqual([expect.objectContaining({ data: expect.objectContaining({ files: [`${r.id}-evidence.pdf`] }) })]);
  });

  it("advises fighting a renter's cancellation under terms in the mandate, with the fee math, and no word of photos", async () => {
    const r = await cancelledBooking("renter", 12);
    await disputeFee(r.id, 8700); // the customer asks for the whole fee back
    const { recommendation } = await deskFor(r.id);
    expect(recommendation).toMatchObject({ action: "fight", headline: "Fight: the customer cancelled under terms they approved at booking.", offerCents: 4350 });
    expect(recommendation.reasons.join(" ")).toMatch(/approved in PayPal at booking.*The shop refunded \$43\.50 of the \$87\.00 fee and kept \$43\.50\./);
    expect(recommendation.reasons.join(" ")).not.toMatch(/photo/);
    // A claim allows no offer in PayPal, so offering the rest is listed but not available.
    expect(recommendation.options.find((o) => o.action === "offer")).toMatchObject({ label: "Offer to refund $43.50", available: false, outcomes: [{ refundCents: 4350, feeCents: 0 }] });
  });

  it("advises giving the rest back when the shop itself cancelled", async () => {
    const r = await cancelledBooking("staff", 72);
    expect(r).toMatchObject({ cancelledBy: "staff", cancelRefundCents: 2000 });
    await disputeFee(r.id, 8700);
    const { recommendation } = await deskFor(r.id);
    expect(recommendation).toMatchObject({ action: "accept", headline: "Accept: the shop cancelled this booking.", offerCents: 6700 });
    expect(recommendation.reasons.join(" ")).toMatch(/The shop cancelled this booking.*refunded \$20\.00 of the \$87\.00 fee and kept \$67\.00/);
    const sha = await desk.prepareEvidence(r.id);
    const pack = await packFor(sha);
    expect(factList(pack.facts).find((f) => f.id === "cancellation")!.text).toMatch(/The shop cancelled the booking .* The shop chose to refund \$20\.00 of the fee, with this reason to the customer: "The kit failed its check"/);
    expect(narrativeProblems(templateNarrative(pack.facts), factList(pack.facts))).toEqual([]);
  });
});
