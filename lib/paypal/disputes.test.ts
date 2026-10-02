// Disputes v1 client: what is allowed comes from PayPal's links, evidence is
// checked against PayPal's limits, and requests go out as documented.
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
delete process.env.DEMO_MODE;
delete process.env.PAYPAL_ENVIRONMENT;

const model = await import("./dispute-model");
const { PayPalDisputeApi } = await import("./disputes");

const API = "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034";

/** The "Show dispute details" sample from PayPal's Disputes API guide, trimmed. */
const inquiry = model.DisputeSchema.parse({
  dispute_id: "PP-R-AYP-10135034",
  create_time: "2025-09-18T09:46:54.926Z",
  update_time: "2025-09-18T09:49:53.336Z",
  disputed_transactions: [{ buyer_transaction_id: "7XB07472F52871902", seller_transaction_id: "8AW70038VH226914P", gross_amount: { currency_code: "USD", value: "2.00" } }],
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "2.00" },
  dispute_state: "REQUIRED_ACTION",
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  evidences: [
    { evidence_type: "CREATE", notes: "Test support case", source: "SUBMITTED_BY_BUYER", date: "2025-09-18T09:46:54.926Z" },
    { evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER", date: "2025-09-18T09:49:53.336Z" },
  ],
  seller_response_due_date: "2025-10-08T09:46:54.926Z",
  allowed_response_options: { accept_claim: { accept_claim_types: ["PARTIAL_REFUND", "REFUND"] }, make_offer: { offer_types: ["REFUND"] } },
  links: [
    { href: API, rel: "self", method: "GET" },
    { href: `${API}/send-message`, rel: "send_message", method: "POST" },
    { href: `${API}/escalate`, rel: "escalate", method: "POST" },
    { href: `${API}/accept-claim`, rel: "accept_claim", method: "POST" },
    { href: `${API}/make-offer`, rel: "make_offer", method: "POST" },
    { href: `${API}/provide-evidence`, rel: "provide_evidence", method: "POST" },
  ],
});

const underReview = { ...inquiry, status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK", links: [
  { href: API, rel: "self", method: "GET" },
  { href: `${API}/require-evidence`, rel: "require-evidence", method: "POST" },
  { href: `${API}/adjudicate`, rel: "adjudicate", method: "POST" },
] };

const pdf = { name: "R-ABC123-evidence.pdf", contentType: "application/pdf" as const, bytes: new TextEncoder().encode("%PDF-1.7") };

function mockPayPal() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      calls.push({ url, init });
      return Response.json({ links: [{ rel: "self", href: API, method: "GET" }] }, { headers: { "paypal-debug-id": "dbg-ok" } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("availableActions", () => {
  it("reads the inquiry-stage options from PayPal's links and allowed_response_options", () => {
    expect(model.availableActions(inquiry)).toEqual({
      provideEvidence: true,
      acceptClaim: ["PARTIAL_REFUND", "REFUND"],
      makeOffer: ["REFUND"],
      escalate: true,
      sendMessage: true,
      provideSupportingInfo: false,
      appeal: false,
      requireEvidence: false,
      adjudicate: false,
    });
  });

  it("treats rel spellings alike and offers nothing a link does not offer", () => {
    const a = model.availableActions(underReview);
    expect(a).toMatchObject({ requireEvidence: true, adjudicate: true, provideEvidence: false, acceptClaim: null, makeOffer: null });
  });
});

describe("chooseEvidenceType", () => {
  it("files under OTHER when PayPal asks for proof a counter rental does not have", () => {
    expect(model.chooseEvidenceType(inquiry)).toBe("OTHER");
    // What the sandbox asked for after require-evidence on a billing claim.
    const asked = ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "PROOF_OF_DELIVERY_SIGNATURE"].map((t) => ({ evidence_type: t, source: "REQUESTED_FROM_SELLER" }));
    expect(model.chooseEvidenceType({ ...inquiry, evidences: asked })).toBe("OTHER");
  });
  it("uses the first requested type the pack really is", () => {
    const asked = ["PROOF_OF_REFUND", "PRICE_DIFFERENCE_REASON", "PROOF_OF_DAMAGE"].map((t) => ({ evidence_type: t, source: "REQUESTED_FROM_SELLER" }));
    expect(model.chooseEvidenceType({ ...inquiry, evidences: asked })).toBe("PRICE_DIFFERENCE_REASON");
  });
});

describe("evidenceParts", () => {
  it("builds the input part and one file part per document", () => {
    const parts = model.evidenceParts({ evidenceType: "OTHER", notes: "  In-store rental.  ", files: [pdf] });
    expect(parts).toEqual([
      { name: "input", json: { evidences: [{ evidence_type: "OTHER", notes: "In-store rental." }] } },
      { name: "file1", filename: "R-ABC123-evidence.pdf", contentType: "application/pdf", bytes: pdf.bytes },
    ]);
  });

  it("refuses what PayPal documents it will refuse", () => {
    const ok = { evidenceType: "OTHER", notes: "n", files: [pdf] };
    expect(() => model.evidenceParts({ ...ok, notes: "x".repeat(2001) })).toThrow(/2000/);
    expect(() => model.evidenceParts({ ...ok, files: [{ ...pdf, name: "pack.v2.pdf" }] })).toThrow(/file name/);
    expect(() => model.evidenceParts({ ...ok, files: [{ ...pdf, name: "photo.jpg" }] })).toThrow(/file name/);
    expect(() => model.evidenceParts({ ...ok, files: [{ ...pdf, contentType: "image/webp" as never, name: "a.webp" }] })).toThrow(/does not accept/);
    expect(() => model.evidenceParts({ ...ok, files: [{ ...pdf, bytes: new Uint8Array(10_000_000) }] })).toThrow(/under 10 MB/);
    const big = { ...pdf, bytes: new Uint8Array(9_000_000) };
    expect(() => model.evidenceParts({ ...ok, files: [big, big, big, big, big, big].map((f, i) => ({ ...f, name: `part${i}.pdf` })) })).toThrow(/50 MB/);
  });
});

describe("PayPalDisputeApi", () => {
  it("posts evidence as multipart to the provide_evidence link with the given request id", async () => {
    const calls = mockPayPal();
    const res = await new PayPalDisputeApi("sandbox").provideEvidence(inquiry, { evidenceType: "OTHER", notes: "Pack attached.", files: [pdf] }, "dispute-evidence:1");
    expect(res).toEqual({ status: 200, debugId: "dbg-ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/provide-evidence`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toBe("dispute-evidence:1");
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.from(calls[0].init.body as Uint8Array).toString();
    expect(body).toContain('Content-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n{"evidences":[{"evidence_type":"OTHER","notes":"Pack attached."}]}');
    expect(body).toContain('Content-Disposition: form-data; name="file1"; filename="R-ABC123-evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\r\n');
  });

  it("refuses an action PayPal did not offer, without calling PayPal", async () => {
    const calls = mockPayPal();
    const api = new PayPalDisputeApi("sandbox");
    await expect(api.adjudicate(inquiry, "SELLER_FAVOR", "x")).rejects.toBeInstanceOf(model.DisputeActionUnavailable);
    await expect(api.provideEvidence(underReview, { evidenceType: "OTHER", notes: "n", files: [] }, "x")).rejects.toThrow(/provide_evidence/);
    expect(calls).toHaveLength(0);
  });

  it("never runs the sandbox-only calls against live, and never follows a link off PayPal's host", async () => {
    const calls = mockPayPal();
    await expect(new PayPalDisputeApi("live").adjudicate(underReview, "SELLER_FAVOR", "x")).rejects.toThrow(/only in the PayPal sandbox/);
    const forged = { ...inquiry, links: [{ href: "https://evil.example/v1/customer/disputes/X/escalate", rel: "escalate", method: "POST" }] };
    await expect(new PayPalDisputeApi("sandbox").escalate(forged, "n", "x")).rejects.toThrow(/refusing/);
    const live = { ...inquiry, links: [{ href: "https://api.paypal.com/v1/customer/disputes/X/escalate", rel: "escalate", method: "POST" }] };
    await expect(new PayPalDisputeApi("sandbox").escalate(live, "n", "x")).rejects.toThrow(/refusing/);
    expect(calls).toHaveLength(0);
  });

  it("follows a link on the api.sandbox host that webhook payloads use, to the configured base", async () => {
    const calls = mockPayPal();
    const fromWebhook = { ...inquiry, links: [{ href: "https://api.sandbox.paypal.com/v1/customer/disputes/PP-R-AYP-10135034/escalate", rel: "escalate", method: "POST" }] };
    await new PayPalDisputeApi("sandbox").escalate(fromWebhook, "n", "x");
    expect(calls.map((c) => c.url)).toEqual([`${API}/escalate`]);
  });

  it("sends documented JSON bodies for accept-claim, make-offer, require-evidence and adjudicate", async () => {
    const calls = mockPayPal();
    const api = new PayPalDisputeApi("sandbox");
    await api.acceptClaim(inquiry, { note: "Refunding the contested part.", type: "PARTIAL_REFUND", refundCents: 150 }, "a");
    await api.makeOffer(inquiry, { note: "Offer", type: "REFUND", amountCents: 100 }, "b");
    await api.requireEvidence(underReview, "SELLER_EVIDENCE", "c");
    await api.adjudicate(underReview, "SELLER_FAVOR", "d");
    const sent = calls.map((c) => [c.url.replace(API, ""), JSON.parse(String(c.init.body))]);
    expect(sent).toEqual([
      ["/accept-claim", { note: "Refunding the contested part.", accept_claim_type: "PARTIAL_REFUND", refund_amount: { currency_code: "USD", value: "1.50" } }],
      ["/make-offer", { note: "Offer", offer_type: "REFUND", offer_amount: { currency_code: "USD", value: "1.00" } }],
      ["/require-evidence", { action: "SELLER_EVIDENCE" }],
      ["/adjudicate", { adjudication_outcome: "SELLER_FAVOR" }],
    ]);
    await expect(api.acceptClaim(inquiry, { note: "n", type: "REFUND_WITH_RETURN" as never }, "e")).rejects.toThrow(/accept_claim REFUND_WITH_RETURN/);
  });

  it("lists disputes for one transaction and validates what comes back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
        expect(url).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes?disputed_transaction_id=27E47755F4775162P&page_size=20");
        return Response.json({ items: [{ dispute_id: "PP-R-1", status: "OPEN", dispute_amount: { currency_code: "USD", value: "35.00" } }] });
      }),
    );
    const items = await new PayPalDisputeApi("sandbox").list({ disputedTransactionId: "27E47755F4775162P" });
    expect(items.map((d) => d.dispute_id)).toEqual(["PP-R-1"]);
    await expect(new PayPalDisputeApi("sandbox").get("../oauth2/token")).rejects.toThrow(/not a dispute id/);
  });
});
