// The MCP endpoint end to end in demo mode: the SDK's own client talks
// Streamable HTTP to handleMcpRequest, the handler behind /api/mcp, with the
// PayPal stand-in and an in-memory database.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { BookingOut, ListItemsOut, QuoteOut, StatusOut } from "./tools";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { canonicalJson } = await import("@/lib/rentals/audit");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { applyPayPalWebhook } = await import("@/lib/rentals/webhooks");
const { handleMcpRequest } = await import("./server");

const ENDPOINT = "http://localhost:3000/api/mcp";

async function connect() {
  const client = new Client({ name: "handback-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: (url, init) => handleMcpRequest(new Request(url, init)) }));
  return client;
}

type Client = Awaited<ReturnType<typeof connect>>;

type Out = {
  list_items: z.infer<typeof ListItemsOut>;
  quote_rental: z.infer<typeof QuoteOut>;
  create_booking: z.infer<typeof BookingOut>;
  get_rental_status: z.infer<typeof StatusOut>;
};

/** Calls a tool and returns its structured result, failing the test on a tool error. */
async function call<N extends keyof Out>(client: Client, name: N, args: Record<string, unknown> = {}): Promise<Out[N]> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Out[N];
}

/** Calls a tool that should fail and returns the message the assistant would see. */
async function refusal(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  return (res.content as { text: string }[])[0].text;
}

const sam = { name: "Sam Rivera", email: "sam@example.com" };
const weekend = () => ({ startDate: addDaysIso(todayIso(), 1), endDate: addDaysIso(todayIso(), 3) });

let client: Client;
beforeAll(async () => {
  await getDb();
  client = await connect();
});

describe("MCP tools", () => {
  it("offers four tools; only create_booking writes, and none can approve, accept, hold or settle", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_booking", "get_rental_status", "list_items", "quote_rental"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== "create_booking");
    expect(tools.find((t) => t.name === "create_booking")?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(await refusal(client, "settle", { rentalId: "R-AAAAAA" })).toMatch(/not found/);
  });

  it("lists the catalog with the shop's date", async () => {
    const out = await call(client, "list_items");
    expect(out.shop.today).toBe(todayIso());
    expect(out.items).toHaveLength(8);
    expect(out.items.find((i) => i.id === "drone-kit")).toMatchObject({ dailyRate: { cents: 4500, usd: "$45.00" }, depositHold: { usd: "$300.00" } });
  });

  it("quotes from the server's prices, with the terms the renter will agree to", async () => {
    const out = await call(client, "quote_rental", { itemId: "drone-kit", ...weekend() });
    expect(out).toMatchObject({ days: 2, payNow: { cents: 9000, usd: "$90.00" }, depositHold: { cents: 30000 } });
    expect(out.priceList.map((p) => p.id)).toContain("missing-battery");
    expect(out.terms.join(" ")).toContain("up to $300.00");
  });

  it("tells the assistant what to fix", async () => {
    const { startDate, endDate } = weekend();
    expect(await refusal(client, "quote_rental", { itemId: "drone-kit", startDate: endDate, endDate: startDate })).toBe(
      "The return date must be after the pickup date.",
    );
    expect(await refusal(client, "quote_rental", { itemId: "jetpack", startDate, endDate })).toBe('There is no rental item "jetpack".');
    expect(await refusal(client, "quote_rental", { itemId: "drone-kit", startDate: "this weekend", endDate })).toMatch(/YYYY-MM-DD/);
    expect(await refusal(client, "create_booking", { itemId: "drone-kit", startDate, endDate, name: "Sam", email: "not an email" })).toMatch(/email/i);
  });

  it("books with a mandate issued to the assistant and a PayPal approval link, and moves no money", async () => {
    const out = await call(client, "create_booking", { itemId: "drone-kit", ...weekend(), ...sam, assistant: "Claude" });
    expect(out.status).toBe("awaiting_renter_approval");
    expect(out.approveUrl).toMatch(/\/demo\/paypal\?token=DEMO-ORDER-/);
    expect(out.rentalPageUrl).toMatch(/\/r\/[A-Za-z0-9_-]{24}$/);
    expect(out.mandate).toMatchObject({
      rentalId: out.rentalId,
      issuedTo: { party: "assistant", assistant: "Claude", actingFor: "Sam Rivera <sam@example.com>" },
      hold: { maxCents: 30000, starts: "at_pickup" },
    });
    // The hash the assistant gets is the SHA-256 of the mandate's canonical JSON.
    expect(createHash("sha256").update(canonicalJson(out.mandate)).digest("hex")).toBe(out.mandateSha256);

    const rental = (await repo.rentalById(await getDb(), out.rentalId))!;
    expect(rental).toMatchObject({ status: "draft", feeCaptureId: null, authorizationId: null, mandateSha256: out.mandateSha256 });
  });

  it("follows the rental to settlement, while only the renter answers the charges", async () => {
    const booking = await call(client, "create_booking", { itemId: "drone-kit", ...weekend(), ...sam });
    const token = booking.rentalPageUrl.split("/r/")[1];

    let status = await call(client, "get_rental_status", { token: booking.rentalPageUrl });
    expect(status).toMatchObject({ status: "draft", approveUrl: booking.approveUrl, amounts: { feePaid: false, heldNow: null } });

    // The renter approves in PayPal and is sent back to their page.
    expect(await svc.returnFromPayPal(token, { token: booking.approveUrl.split("token=")[1], PayerID: "DEMOPAYER" })).toBe("approved");
    status = await call(client, "get_rental_status", { token });
    expect(status).toMatchObject({ status: "booked", approveUrl: null, amounts: { feePaid: true } });

    // Pickup and return at the counter: the second flight battery is missing.
    await svc.addPhoto(booking.rentalId, "checkout", { sample: "drone-kit/before" });
    await svc.holdDeposit(booking.rentalId);
    await svc.addPhoto(booking.rentalId, "checkin", { sample: "drone-kit/after__missing-battery" });
    await svc.inspect(booking.rentalId);
    await svc.sendToCustomer(booking.rentalId);

    status = await call(client, "get_rental_status", { token });
    expect(status).toMatchObject({ status: "customer_review", amounts: { heldNow: { usd: "$300.00" } } });
    expect(status.waitingForRenter.map((f) => f.charge)).toEqual(["Replace flight battery"]);
    expect(status.nextStep).toContain(booking.rentalPageUrl);

    // The renter answers on their own page; the counter settles.
    await svc.respondAsCustomer(
      token,
      status.waitingForRenter.map((f) => ({ findingId: f.findingId, answer: "accept" as const })),
    );
    await svc.settle(booking.rentalId);
    status = await call(client, "get_rental_status", { token });
    expect(status).toMatchObject({ status: "settled", amounts: { kept: { usd: "$89.00" }, released: { usd: "$211.00" }, heldNow: null } });

    // A PayPal dispute after settlement changes the status, not the money already moved.
    const captureId = (await repo.rentalById(await getDb(), booking.rentalId))!.settlementCaptureId;
    await applyPayPalWebhook({
      id: `WH-${booking.rentalId}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: { dispute_id: "PP-D-MCP", disputed_transactions: [{ seller_transaction_id: captureId! }] },
    });
    status = await call(client, "get_rental_status", { token });
    expect(status).toMatchObject({ status: "disputed", amounts: { heldNow: null, kept: { usd: "$89.00" }, released: { usd: "$211.00" } } });
  });

  it("does not find a rental without its token", async () => {
    expect(await refusal(client, "get_rental_status", { token: "R-ABCDEF-guess" })).toMatch(/No rental has that token/);
  });
});

describe("MCP over HTTP", () => {
  const post = (headers: Record<string, string>) =>
    handleMcpRequest(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  it("refuses browsers on other sites, and has no session stream", async () => {
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ Origin: "http://localhost:3000" })).status).toBe(200);
    expect((await handleMcpRequest(new Request(ENDPOINT, { method: "GET", headers: { Accept: "text/event-stream" } }))).status).toBe(405);
  });
});
