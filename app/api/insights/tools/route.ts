import { runAgentTool } from "@/lib/insights/agent-tools";
import { staffOnlyResponse } from "@/lib/staff-access";

/**
 * The deposit desk agent's tools, for the owner's dashboard. Staff only, like
 * the rest of the counter. Every tool reads; draft_refund only prepares a
 * proposal a person sends from the rental page. No PayPal call happens here.
 */
export async function POST(req: Request) {
  const refused = await staffOnlyResponse();
  if (refused) return refused;
  let body: { tool?: unknown; args?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Send JSON: { tool, args }." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const result = await runAgentTool(String(body.tool ?? ""), body.args);
  return Response.json(result, { status: result.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
}
