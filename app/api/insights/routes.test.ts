// The dashboard agent's two server routes and its tools, in demo mode on an
// in-memory database: staff only when SHOP_ACCESS_CODE is set, the Gemini
// key never in a reply, a clean refusal without a key, a per-session limit,
// tools that read only, and refund drafts held to the counter's limits.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined, headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "handback_staff" && jar.cookie ? { name, value: jar.cookie } : undefined) }),
  headers: async () => new Headers(jar.headers),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => Promise.reject(new Error(`redirect ${url}`)) }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

// The model call is replaced; everything around it is real.
const turns = vi.hoisted(() => ({ calls: 0, fail: null as Error | null }));
vi.mock("@/lib/insights/llm", async (original) => {
  const real = await original<typeof import("@/lib/insights/llm")>();
  return {
    ...real,
    runTurn: vi.fn(async () => {
      turns.calls++;
      if (turns.fail) throw turns.fail;
      return { id: "r", createdAt: 0, status: "completed", output: [{ id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Two holds need you.", annotations: [] }] }] };
    }),
  };
});

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.SHOP_ACCESS_CODE;
// A made-up key in the shape of a Google one, assembled so no key-shaped string sits in the source.
const KEY = ["AI", "za", "SyTESTKEY-0123456789abcdefghijklmnopq"].join("");

const llm = await import("./llm/route");
const toolsRoute = await import("./tools/route");
const { getDb } = await import("@/lib/db/client");
const svc = await import("@/lib/rentals/service");
const repo = await import("@/lib/rentals/repo");
const { refundCharge } = await import("@/lib/rentals/refunds");
const desk = await import("@/lib/disputes/service");
const { runAgentTool } = await import("@/lib/insights/agent-tools");
const { issueStaffToken } = await import("@/lib/staff-access");
const { safeError, createTurnLimiter } = await import("@/lib/insights/llm");
const { spacedDates } = await import("@/test/dates");

const CODE = "open-sesame-door";
const turnBody = { request: { input: [{ type: "message", role: "user", content: [{ type: "text", text: "Which holds need attention?" }] }], responseFormat: { type: "text" } } };
const post = (body: unknown) => new Request("http://localhost/api/insights/llm", { method: "POST", body: JSON.stringify(body) });
const toolPost = (tool: string, args: unknown) => new Request("http://localhost/api/insights/tools", { method: "POST", body: JSON.stringify({ tool, args }) });

async function settled(name = "Maya Chen") {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name, email: "maya@example.com", ...spacedDates() });
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
  return rentalId;
}

/** Everything a tool could have written: rentals, refunds, the audit log, PayPal stand-in state. */
async function footprint() {
  const db = await getDb();
  const [r] = await db.query<{ rentals: string; refunds: string; events: string; paypal: string }>(
    "select (select count(*) from rentals) as rentals, (select count(*) from refunds) as refunds, (select count(*) from events) as events, (select coalesce(string_agg(state::text, ''), '') from demo_paypal) as paypal",
  );
  return r;
}

beforeAll(async () => {
  await getDb();
});

afterEach(() => {
  delete process.env.SHOP_ACCESS_CODE;
  delete process.env.GEMINI_API_KEY;
  jar.cookie = undefined;
  turns.fail = null;
});

describe("/api/insights/llm", () => {
  it("is staff only when the counter has a code", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    process.env.GEMINI_API_KEY = KEY;
    const before = turns.calls;
    const res = await llm.POST(post(turnBody));
    expect(res.status).toBe(401);
    expect(turns.calls).toBe(before);
    jar.cookie = issueStaffToken(CODE).value;
    expect((await llm.POST(post(turnBody))).status).toBe(200);
  });

  it("refuses cleanly without a Gemini key", async () => {
    const res = await llm.POST(post(turnBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/needs a Gemini key/);
  });

  it("answers a valid turn and refuses shapes Studio never sends", async () => {
    process.env.GEMINI_API_KEY = KEY;
    const ok = await llm.POST(post(turnBody));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.response.output[0].content[0].text).toBe("Two holds need you.");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((await llm.POST(post({ request: { input: [{ type: "message", role: "root", content: [] }] } }))).status).toBe(400);
    expect((await llm.POST(new Request("http://localhost/api/insights/llm", { method: "POST", body: "{not json" }))).status).toBe(400);
  });

  it("never echoes the key when Gemini fails", async () => {
    process.env.GEMINI_API_KEY = KEY;
    turns.fail = new Error(`400 Bad Request https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${KEY} API key ${KEY} not valid`);
    const res = await llm.POST(post(turnBody));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain("[key]");
    expect(safeError(new Error(`bad ${["AI", "za"].join("")}SyAnother0123456789012345678901 here`), {})).toBe("bad [key] here");
  });

  it("limits turns per session and over everyone", () => {
    const limiter = createTurnLimiter(3, 5, 60_000);
    const t = 1_000_000;
    expect([0, 1, 2].map((i) => limiter.take("a", t + i))).toEqual([0, 0, 0]);
    expect(limiter.take("a", t + 3)).toBeGreaterThan(0);
    expect(limiter.take("b", t + 4)).toBe(0);
    expect(limiter.take("c", t + 5)).toBe(0);
    // Five turns in the window from everyone: a new session waits too.
    expect(limiter.take("d", t + 6)).toBeGreaterThan(0);
    // After the window, both limits are clear again.
    expect(limiter.take("a", t + 60_010)).toBe(0);
  });
});

describe("/api/insights/tools", () => {
  it("is staff only when the counter has a code", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    expect((await toolsRoute.POST(toolPost("holds_needing_attention", {}))).status).toBe(401);
    jar.cookie = issueStaffToken(CODE).value;
    expect((await toolsRoute.POST(toolPost("holds_needing_attention", {}))).status).toBe(200);
  });

  it("refuses unknown tools and bad arguments", async () => {
    expect(await (await toolsRoute.POST(toolPost("refund_now", {}))).json()).toMatchObject({ ok: false, error: "Unknown tool refund_now." });
    const bad = await runAgentTool("draft_refund", { rental_id: "R-1", amount_cents: 12.5, reason: "" });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^rental_id:/), expect.stringMatching(/^amount_cents: Whole cents/), expect.stringMatching(/^reason:/)]));
    expect((await runAgentTool("holds_needing_attention", { anything: true })).ok).toBe(false);
  });
});

describe("the deposit desk's tools", () => {
  it("read without writing anything, and name the renter by first name only", async () => {
    const id = await settled("Priya Patel");
    const before = await footprint();
    const holds = await runAgentTool("holds_needing_attention", { include_all: true });
    const explained = await runAgentTool("explain_rental", { rental_id: id });
    expect(holds.ok && explained.ok).toBe(true);
    const json = JSON.stringify(explained);
    expect(json).toContain('"renter":"Priya"');
    expect(json).not.toMatch(/Patel|@example\.com/);
    const rental = (await repo.rentalById(await getDb(), id))!;
    expect(json).not.toContain(rental.token);
    expect(explained.ok && (explained.result as { audit_trail: { chain_intact: boolean } }).audit_trail.chain_intact).toBe(true);
    expect(await footprint()).toEqual(before);
  });

  it("drafts a refund within what is left to refund, writes nothing and calls no PayPal", async () => {
    const id = await settled();
    const rental = (await repo.rentalById(await getDb(), id))!;
    await refundCharge(id, { captureId: rental.settlementCaptureId!, cents: 1000, reason: "Hood found", seq: 1 });
    const before = await footprint();
    const over = await runAgentTool("draft_refund", { rental_id: id, amount_cents: 2600, reason: "Too much" });
    expect(over).toMatchObject({ ok: false, error: expect.stringMatching(/At most \$25\.00 is left/) });
    const ok = await runAgentTool("draft_refund", { rental_id: id, amount_cents: 2500, reason: "The hood turned up in the bag." });
    expect(ok).toMatchObject({
      ok: true,
      result: { status: "draft, not sent", amount: "$25.00", left_after: "$0.00", capture_id: rental.settlementCaptureId, confirm_at: expect.stringContaining(`/shop/rentals/${id}?refund=2500&capture=`) },
    });
    expect(await footprint()).toEqual(before);
  });

  it("refuses a draft while a PayPal dispute is open, before settling, and for an unknown rental", async () => {
    const disputed = await settled();
    await desk.demoOpenDispute(disputed);
    expect(await runAgentTool("draft_refund", { rental_id: disputed, amount_cents: 100, reason: "Sorry" })).toMatchObject({ ok: false, error: expect.stringMatching(/open PayPal dispute/) });
    const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name: "Kai Tanaka", email: "kai@example.com", ...spacedDates() });
    await svc.confirmBooking(orderId);
    expect(await runAgentTool("draft_refund", { rental_id: rentalId, amount_cents: 100, reason: "Sorry" })).toMatchObject({ ok: false, error: expect.stringMatching(/Only a settled rental/) });
    expect(await runAgentTool("explain_rental", { rental_id: "R-ZZZZZZ" })).toMatchObject({ ok: false, error: "There is no rental R-ZZZZZZ." });
  });
});
