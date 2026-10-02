import { handleMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * The MCP endpoint for assistants (docs/agents.md): Streamable HTTP, stateless.
 * Tools can quote and start a booking; money only moves after the renter
 * approves in PayPal and the counter settles.
 */
export async function POST(req: Request) {
  return handleMcpRequest(req);
}

export async function GET(req: Request) {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleMcpRequest(req);
}
