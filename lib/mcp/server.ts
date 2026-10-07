import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { todayIso } from "@/lib/dates";
import { UserError } from "@/lib/rentals/types";
import { appUrl, SHOP } from "@/lib/shop";
import { BookingArgs, BookingOut, createBooking, listItems, ListItemsOut, QuoteArgs, QuoteOut, quoteRental, rentalStatus, StatusArgs, StatusOut } from "./tools";

function instructions(): string {
  return [
    `${SHOP.name} in ${SHOP.city} rents cameras, lenses, drones, audio gear and bikes through Handback. Today is ${todayIso()} (UTC).`,
    "",
    "To book for the person you are helping:",
    "1. Call list_items to find the item, then quote_rental for their dates. Before booking, tell them the rental fee, the deposit hold and the terms.",
    "2. Call create_booking with their name and email. It returns approveUrl (PayPal) and statusToken.",
    "3. Give them approveUrl, and only them. They approve the fee in PayPal themselves; nothing is paid until they do. PayPal then opens their " +
      "private rental page, which you do not get.",
    "",
    "You cannot pay, approve a payment, cancel a booking, hold a deposit, accept or question a charge, or settle. Those steps belong to the renter " +
      "(in PayPal and on their rental page, where they can also cancel before pickup under the terms quote_rental lists) and to the shop's counter. " +
      "get_rental_status with the statusToken shows where a rental stands, including a cancellation and its refund.",
  ].join("\n");
}

/**
 * Runs a tool and shapes the reply: structured content plus the same JSON as
 * text for clients that only read text. A UserError's message goes back to
 * the assistant so it can correct itself; anything else is logged and hidden.
 */
async function run(fn: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (err) {
    if (err instanceof UserError) return { isError: true, content: [{ type: "text", text: err.message }] };
    console.error("mcp tool failed", err);
    return { isError: true, content: [{ type: "text", text: "Something went wrong on our side. Nothing was charged; try again." }] };
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** One MCP server with Handback's four tools. Stateless: built fresh for every request. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "handback", title: `${SHOP.name} (Handback)`, version: "0.1.0" }, { instructions: instructions() });

  server.registerTool(
    "list_items",
    {
      title: "List rental items",
      description: "The shop's rental items with daily rate, deposit hold and what comes in the box. Also gives today's date at the shop.",
      outputSchema: ListItemsOut,
      annotations: readOnly,
    },
    () => run(listItems),
  );

  server.registerTool(
    "quote_rental",
    {
      title: "Quote a rental",
      description:
        "Prices a rental for given dates: the fee paid at booking, the deposit held at pickup, the repair price list and the terms the renter agrees to. Changes nothing.",
      inputSchema: QuoteArgs,
      outputSchema: QuoteOut,
      annotations: readOnly,
    },
    (args) => run(() => quoteRental(args)),
  );

  server.registerTool(
    "create_booking",
    {
      title: "Create a booking",
      description:
        "Starts a booking for the renter and returns a PayPal approval link for them. Creates an unpaid booking and its deposit mandate; " +
        "no money moves until the renter approves in PayPal. Each call creates a new booking, so call it once per rental.",
      inputSchema: BookingArgs,
      outputSchema: BookingOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => createBooking(args)),
  );

  server.registerTool(
    "get_rental_status",
    {
      title: "Check a rental",
      description:
        "Where a rental stands: status, what is paid, held, kept or released, and any proposed charges waiting for the renter. Takes the statusToken " +
        "from create_booking. The renter answers charges on their own page; no tool can.",
      inputSchema: StatusArgs,
      outputSchema: StatusOut,
      annotations: readOnly,
    },
    (args) => run(() => rentalStatus(args)),
  );

  return server;
}

/**
 * MCP's transport spec asks servers to check Origin against DNS rebinding.
 * Non-browser clients send none; a browser may call only from this app.
 */
export function originAllowed(origin: string | null): boolean {
  return origin === null || origin === new URL(appUrl()).origin;
}

const jsonRpcError = (status: number, message: string, headers?: HeadersInit) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers });

/**
 * Streamable HTTP, stateless: each POST gets a fresh server and transport and
 * a plain JSON answer. With no sessions and no server-initiated messages,
 * GET and DELETE are refused with 405, as the transport spec allows.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"))) return jsonRpcError(403, "Origin not allowed.");
  if (req.method !== "POST") return jsonRpcError(405, "This MCP server is stateless: send JSON-RPC with POST.", { Allow: "POST" });
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
