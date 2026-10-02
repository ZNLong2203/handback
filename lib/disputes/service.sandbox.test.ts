// The dispute desk in sandbox mode with PayPal's REST API mocked at fetch:
// the real client, the hand-built multipart body and the service together.
// The fake PayPal behind fetch reuses the demo stand-in's state machine,
// which copies what the sandbox did.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "memory";
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
delete process.env.DEMO_MODE;
delete process.env.PAYPAL_ENVIRONMENT;
delete process.env.GEMINI_API_KEY;

const { DemoDisputeApi } = await import("@/lib/paypal/demo-disputes");
const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
const { PayPalDisputeApi } = await import("@/lib/paypal/disputes");
const model = await import("@/lib/paypal/dispute-model");
(globalThis as { depositGateway?: unknown }).depositGateway = new DemoDepositGateway();
(globalThis as { disputeApi?: unknown }).disputeApi = new PayPalDisputeApi("sandbox");

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const desk = await import("./service");
const disputes = await import("./repo");

type Part = { name: string; filename: string | null; type: string | null; body: Buffer };

/** Splits a multipart/form-data body the way a server would. */
function parseMultipart(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(.+)$/.exec(contentType)![1];
  const parts: Part[] = [];
  let at = body.indexOf(`--${boundary}\r\n`);
  while (at !== -1) {
    const start = at + boundary.length + 4;
    const next = body.indexOf(`\r\n--${boundary}`, start);
    const chunk = body.subarray(start, next);
    const split = chunk.indexOf("\r\n\r\n");
    const head = chunk.subarray(0, split).toString();
    parts.push({
      name: /name="([^"]+)"/.exec(head)![1],
      filename: /filename="([^"]+)"/.exec(head)?.[1] ?? null,
      type: /Content-Type: (.+)/i.exec(head)?.[1].trim() ?? null,
      body: chunk.subarray(split + 4),
    });
    at = body.indexOf(`--${boundary}\r\n`, next + 2);
  }
  return parts;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const server = new DemoDisputeApi();
type Seen = { method: string; path: string; requestId: string | null; contentType: string | null; body: Buffer | null };
const seen: Seen[] = [];
let failNextEvidence = false;
/** Files the next evidence, then loses the reply, as a stalled connection would. */
let loseNextEvidenceReply = false;

beforeAll(async () => {
  await getDb();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      if (u.pathname === "/v1/oauth2/token") return Response.json({ access_token: "token", expires_in: 3600 });
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = init.body ? Buffer.from(init.body as Uint8Array | string) : null;
      seen.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, requestId: headers["PayPal-Request-Id"] ?? null, contentType: headers["Content-Type"] ?? null, body });
      const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { "paypal-debug-id": `dbg-${seen.length}` } });
      const [, , , , id, action] = u.pathname.split("/");
      if (!id) return reply({ items: await server.list({ disputedTransactionId: u.searchParams.get("disputed_transaction_id") ?? undefined }) });
      const d = await server.get(id);
      if (!action) return reply(d);
      const json = () => JSON.parse(body!.toString());
      const ok = { links: [{ rel: "self", method: "GET", href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}` }] };
      // What the sandbox answered to an action its links no longer offered (2026-10-02).
      if (!model.actionLink(d, action.replace(/-/g, "_"))) {
        return reply({ name: "UNPROCESSABLE_ENTITY", debug_id: "dbg-state", details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE", description: "The requested action could not be performed, semantically incorrect, or failed business validation." }] }, 422);
      }
      if (action === "provide-evidence") {
        if (failNextEvidence) {
          failNextEvidence = false;
          return reply({ name: "UNPROCESSABLE_ENTITY", debug_id: "dbg-422", details: [{ issue: "INVALID_EVIDENCE_FILE", description: "The evidence file is invalid." }] }, 422);
        }
        const parts = parseMultipart(body!, headers["Content-Type"]);
        const input = JSON.parse(parts[0].body.toString()).evidences[0];
        const files = parts.slice(1).map((p) => ({ name: p.filename!, contentType: p.type as "application/pdf", bytes: new Uint8Array(p.body) }));
        await server.provideEvidence(d, { evidenceType: input.evidence_type, notes: input.notes, files }, "x");
        if (loseNextEvidenceReply) {
          loseNextEvidenceReply = false;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
      } else if (action === "require-evidence") await server.requireEvidence(d, json().action, "x");
      else if (action === "adjudicate") await server.adjudicate(d, json().adjudication_outcome, "x");
      else if (action === "accept-claim") await server.acceptClaim(d, { note: json().note, type: json().accept_claim_type }, "x");
      else return reply({ name: "NOT_FOUND" }, 404);
      return reply(ok);
    }),
  );
});

afterAll(() => vi.unstubAllGlobals());

async function settledRental() {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name: "Maya Chen", email: "maya@example.com", startDate: todayIso(), endDate: addDaysIso(todayIso(), 3) });
  const { token } = await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(rentalId);
  await svc.acknowledgeCheckout(token);
  await svc.addPhoto(rentalId, "checkin", { sample: "camera-kit/after__missing-hood" });
  await svc.inspect(rentalId);
  const charges = (await repo.latestAssessment(await getDb(), rentalId))!.findings.filter((f) => f.staff === "keep");
  await svc.sendToCustomer(rentalId);
  await svc.respondAsCustomer(token, charges.map((f) => ({ findingId: f.id, answer: "accept" as const })));
  await svc.settle(rentalId);
  return (await repo.rentalById(await getDb(), rentalId))!;
}

describe("dispute desk against a mocked PayPal REST API", () => {
  it("finds the dispute by capture, files the pack as multipart, and follows the sandbox to a decision", async () => {
    const r = await settledRental();
    const opened = await server.open({ sellerTransactionId: r.settlementCaptureId!, transactionCents: 3500, disputedCents: 2000, reason: "INCORRECT_AMOUNT", note: "Wrong amount.", custom: r.id, invoiceNumber: `${r.id}-damage` });

    expect(await desk.findDisputes(r.id)).toBe(1);
    expect(seen.some((s) => s.path === `/v1/customer/disputes?disputed_transaction_id=${r.settlementCaptureId}&page_size=20`)).toBe(true);
    expect((await repo.rentalById(await getDb(), r.id))!).toMatchObject({ status: "disputed", disputeId: opened.dispute_id });

    // A 422 from PayPal is logged with its debug id, explained, and can be retried.
    failNextEvidence = true;
    await expect(desk.submitEvidence(r.id)).rejects.toThrow(/PayPal could not complete "send the evidence": The evidence file is invalid\. \(PayPal reference dbg-422\)/);
    const errors = (await repo.eventsFor(await getDb(), r.id)).filter((e) => e.type === "paypal.error");
    expect(errors.at(-1)!.data).toMatchObject({ step: "send the evidence", issue: "INVALID_EVIDENCE_FILE", debugId: "dbg-422" });

    const packSha = await desk.submitEvidence(r.id);
    const posts = seen.filter((s) => s.method === "POST" && s.path.endsWith("/provide-evidence"));
    expect(posts).toHaveLength(2);
    const post = posts[1];
    expect(post.requestId).toBe(`dispute-evidence:${opened.dispute_id}:${opened.seller_response_due_date}`);
    const parts = parseMultipart(post.body!, post.contentType!);
    expect(parts.map((p) => [p.name, p.filename, p.type])).toEqual([
      ["input", null, "application/json"],
      ["file1", `${r.id}-evidence.pdf`, "application/pdf"],
      ["file2", `${r.id}-pickup.jpg`, "image/jpeg"],
      ["file3", `${r.id}-return.jpg`, "image/jpeg"],
    ]);
    const input = JSON.parse(parts[0].body.toString());
    expect(input.evidences[0].evidence_type).toBe("OTHER");
    expect(input.evidences[0].notes).toContain(packSha);
    expect(sha(parts[1].body)).toBe(packSha);
    const inspections = await repo.inspectionsFor(await getDb(), r.id);
    expect(sha(parts[2].body)).toBe(inspections.find((i) => i.phase === "checkout")!.photoSha);
    expect(sha(parts[3].body)).toBe(inspections.find((i) => i.phase === "checkin")!.photoSha);
    // Under review PayPal sends no answer deadline, so none is shown (sandbox GET, 2026-10-02).
    const reviewing = (await disputes.disputeById(await getDb(), opened.dispute_id))!;
    expect(reviewing).toMatchObject({ status: "UNDER_REVIEW", sellerResponseDueAt: null });
    expect(reviewing.paypal).not.toHaveProperty("seller_response_due_date");

    await desk.sandboxRequireEvidence(r.id);
    const asked = (await disputes.disputeById(await getDb(), opened.dispute_id))!;
    expect(asked.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(asked.sellerResponseDueAt).toBe((await server.get(opened.dispute_id)).seller_response_due_date);
    expect(asked.sellerResponseDueAt).not.toBeNull();
    const require = seen.filter((s) => s.path.endsWith("/require-evidence"));
    expect(require.map((s) => JSON.parse(s.body!.toString()))).toEqual([{ action: "SELLER_EVIDENCE" }]);
    await desk.submitEvidence(r.id);
    const ids = seen.filter((s) => s.path.endsWith("/provide-evidence")).map((s) => s.requestId);
    expect(new Set(ids.slice(1)).size).toBe(2); // a new round, a new request id

    await desk.sandboxDecide(r.id, "BUYER_FAVOR");
    const decided = (await server.get(opened.dispute_id))!;
    expect(decided.dispute_outcome).toEqual({ outcome_code: "RESOLVED_BUYER_FAVOUR", amount_refunded: { currency_code: "USD", value: "20.00" } });
    const log = await repo.eventsFor(await getDb(), r.id);
    expect(log.at(-1)).toMatchObject({ type: "dispute.resolved", data: { outcome: "RESOLVED_BUYER_FAVOUR", refundedCents: 2000 } });
    expect(log.find((e) => e.type === "dispute.sandbox_decided")!.data).toMatchObject({ outcome: "BUYER_FAVOR", debugId: expect.stringMatching(/^dbg-/) });
    expect((await repo.rentalById(await getDb(), r.id))!.status).toBe("settled");
  });

  it("records evidence PayPal filed although the reply was lost and the retry was refused", async () => {
    const r = await settledRental();
    const opened = await server.open({ sellerTransactionId: r.settlementCaptureId!, transactionCents: 3500, disputedCents: 2000, reason: "INCORRECT_AMOUNT", note: "n", custom: r.id, invoiceNumber: null });
    await desk.findDisputes(r.id);
    loseNextEvidenceReply = true;
    const from = seen.length;
    await desk.submitEvidence(r.id);

    // The same request id went out twice; the second was refused because the case had moved on.
    const posts = seen.slice(from).filter((s) => s.path.endsWith("/provide-evidence"));
    expect(posts).toHaveLength(2);
    expect(posts[0].requestId).toBe(posts[1].requestId);
    const filed = (await server.get(opened.dispute_id)).evidences!.filter((e) => e.source === "SUBMITTED_BY_SELLER");
    expect(filed).toHaveLength(1);

    const log = await repo.eventsFor(await getDb(), r.id);
    expect(log.filter((e) => e.type === "paypal.error").at(-1)!.data).toMatchObject({ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE" });
    expect(log.find((e) => e.type === "dispute.evidence_sent")!.data).toMatchObject({ disputeId: opened.dispute_id, confirmedByRead: true });
    // Without a new filing on PayPal's side, an error still stays an error.
    await desk.sandboxRequireEvidence(r.id);
    failNextEvidence = true;
    await expect(desk.submitEvidence(r.id)).rejects.toThrow(/The evidence file is invalid/);
  });

  it("never calls PayPal for an action the dispute's links do not offer", async () => {
    const r = await settledRental();
    const opened = await server.open({ sellerTransactionId: r.settlementCaptureId!, transactionCents: 3500, disputedCents: 2000, reason: "INCORRECT_AMOUNT", note: "n", custom: r.id, invoiceNumber: null });
    await desk.findDisputes(r.id);
    const before = seen.filter((s) => s.method === "POST").length;
    await expect(desk.sandboxDecide(r.id, "SELLER_FAVOR")).rejects.toThrow(/does not offer to decide the case/);
    await expect(desk.makeOffer(r.id, 500)).rejects.toThrow(/does not offer to make an offer/);
    expect(seen.filter((s) => s.method === "POST").length).toBe(before);
    expect(model.availableActions(await server.get(opened.dispute_id)).adjudicate).toBe(false);
  });
});
