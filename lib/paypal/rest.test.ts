// The REST client against a mocked fetch: retries keep the request id and
// the exact multipart bytes, a 401 refreshes the token once, and an outage
// page that is not JSON still ends as a PayPalError.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
delete process.env.DEMO_MODE;

const { paypalRequest, paypalRest } = await import("./rest");
const { PayPalError } = await import("./errors");

type Call = { url: string; method: string; headers: Record<string, string>; body: Uint8Array | string | undefined };

function mockFetch(replies: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  let tokens = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/v1/oauth2/token")) {
      tokens += 1;
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as Uint8Array | string | undefined });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, tokenCount: () => tokens };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("paypalRequest", () => {
  it("retries a multipart POST after a 503 with the same request id and the same bytes", async () => {
    const { calls } = mockFetch([
      json(503, { name: "SERVICE_UNAVAILABLE", debug_id: "dbg-1" }, { "retry-after": "0.01" }),
      json(200, { links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1" }] }, { "paypal-debug-id": "dbg-2" }),
    ]);
    const res = await paypalRequest<{ links: unknown[] }>("POST", "/v1/customer/disputes/PP-D-1/provide-evidence", {
      requestId: "evidence:PP-D-1",
      multipart: [
        { name: "input", json: { evidences: [{ evidence_type: "OTHER" }] } },
        { name: "file1", filename: "pack.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF") },
      ],
    });
    expect(res).toMatchObject({ status: 200, debugId: "dbg-2" });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers["PayPal-Request-Id"]).toBe("evidence:PP-D-1");
      expect(c.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=handback-[0-9a-f]{32}$/);
    }
    expect(Buffer.from(calls[0].body as Uint8Array).equals(Buffer.from(calls[1].body as Uint8Array))).toBe(true);
    expect(Buffer.from(calls[0].body as Uint8Array).toString()).toContain('name="input"\r\nContent-Type: application/json\r\n\r\n{"evidences"');
  });

  it("generates one request id per call, not one per attempt", async () => {
    const { calls } = mockFetch([json(500, { name: "INTERNAL_SERVER_ERROR" }, { "retry-after": "0.01" }), json(200, {})]);
    await paypalRest("POST", "/v1/customer/disputes/PP-D-2/adjudicate", { body: { adjudication_outcome: "SELLER_FAVOR" } });
    expect(calls[0].headers["PayPal-Request-Id"]).toBeTruthy();
    expect(calls[1].headers["PayPal-Request-Id"]).toBe(calls[0].headers["PayPal-Request-Id"]);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("refreshes the token once on a 401 and does not send a request id on GET", async () => {
    const m = mockFetch([json(401, { name: "AUTHENTICATION_FAILURE" }), json(200, { dispute_id: "PP-D-3" })]);
    const before = m.tokenCount();
    await expect(paypalRest("GET", "/v1/customer/disputes/PP-D-3")).resolves.toEqual({ dispute_id: "PP-D-3" });
    expect(m.tokenCount()).toBe(before + 1);
    expect(m.calls[0].headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("turns a non-JSON outage page into a retryable PayPalError, and gives up after the last attempt", async () => {
    const page = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "retry-after": "0.01" } });
    mockFetch([page, page, page]);
    const err = await paypalRest("GET", "/v1/customer/disputes/PP-D-4").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 502, retryable: true });
  });

  it("retries a response whose body stalls, and a token call that fails, as network failures", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/oauth2/token")) {
          tokenCalls += 1;
          if (tokenCalls === 1) throw new TypeError("fetch failed");
          return Response.json({ access_token: "t", expires_in: 3600 });
        }
        apiCalls += 1;
        if (apiCalls === 1) {
          // Headers arrive, then reading the body times out.
          const stalled = new ReadableStream({ pull: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) });
          return new Response(stalled, { status: 200 });
        }
        return json(200, { dispute_id: "PP-D-6" });
      }),
    );
    // A fresh module, so no token is cached from the tests above.
    vi.resetModules();
    const fresh = await import("./rest");
    const res = await fresh.paypalRequest<{ dispute_id: string }>("GET", "/v1/customer/disputes/PP-D-6", { attempts: 3 });
    expect(res.data.dispute_id).toBe("PP-D-6");
    expect({ tokenCalls, apiCalls }).toEqual({ tokenCalls: 2, apiCalls: 2 });
  });

  it("retries when the token endpoint answers 503, and when the refresh after a 401 fails", async () => {
    let tokenCalls = 0;
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith("/v1/oauth2/token")) {
          tokenCalls += 1;
          if (tokenCalls === 1) return json(503, { name: "SERVICE_UNAVAILABLE" });
          if (tokenCalls === 3) throw new TypeError("fetch failed");
          return Response.json({ access_token: `t${tokenCalls}`, expires_in: 3600 });
        }
        auth.push((init.headers as Record<string, string>).Authorization);
        // The first token is refused once, as an expired one would be.
        return auth.length === 1 ? json(401, { name: "AUTHENTICATION_FAILURE" }) : json(200, { dispute_id: "PP-D-7" });
      }),
    );
    vi.resetModules();
    const fresh = await import("./rest");
    const res = await fresh.paypalRequest<{ dispute_id: string }>("GET", "/v1/customer/disputes/PP-D-7", { attempts: 3 });
    expect(res.data.dispute_id).toBe("PP-D-7");
    // 503, then t2 (refused with 401), then a refresh that fails on the network, then t4.
    expect(tokenCalls).toBe(4);
    expect(auth).toEqual(["Bearer t2", "Bearer t4"]);
  });

  it("does not retry a token request PayPal refuses with a 4xx", async () => {
    let tokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.endsWith("/v1/oauth2/token")) throw new Error(`unexpected request to ${url}`);
        tokenCalls += 1;
        return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
      }),
    );
    vi.resetModules();
    const fresh = await import("./rest");
    const err = await fresh.paypalRequest("GET", "/v1/customer/disputes/PP-D-8").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, errorName: "invalid_client" });
    expect(tokenCalls).toBe(1);
  });

  it("does not retry a 422 and keeps PayPal's issue and debug id", async () => {
    const { calls } = mockFetch([
      json(422, { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg-9", details: [{ issue: "INVALID_EVIDENCE_FILE", description: "Bad file." }] }),
    ]);
    const err = await paypalRest("POST", "/v1/customer/disputes/PP-D-5/provide-evidence", { multipart: [{ name: "input", json: {} }] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, issue: "INVALID_EVIDENCE_FILE", debugId: "dbg-9" });
    expect(calls).toHaveLength(1);
  });
});
