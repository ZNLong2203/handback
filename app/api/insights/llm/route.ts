import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { LlmRequestSchema } from "@/lib/insights/gemini";
import { insightsAiConfigured, runTurn, safeError, turnLimiter } from "@/lib/insights/llm";
import { clientAddress, STAFF_COOKIE, staffOnlyResponse } from "@/lib/staff-access";

/**
 * One model turn for AG Studio's agents on the owner's dashboard. Studio runs
 * the agent loop in the browser; its adapter posts each turn here, and this
 * route calls Gemini with the server's key, which never reaches the browser.
 * Staff only, limited per session, and refused cleanly without a key.
 */

const MAX_BODY = 1_500_000;
const json = (body: unknown, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });

/** Who the turn counts against: the staff cookie when the counter has a code, else the client address. */
async function sessionKey(): Promise<string> {
  const cookie = (await cookies()).get(STAFF_COOKIE)?.value;
  const who = cookie ? `cookie:${cookie}` : `ip:${await clientAddress()}`;
  return createHash("sha256").update(who).digest("base64url");
}


export async function POST(req: Request) {
  const refused = await staffOnlyResponse();
  if (refused) return refused;
  if (!insightsAiConfigured()) {
    return json({ error: "The AI assistant needs a Gemini key: set GEMINI_API_KEY on the server. The dashboard works without it." }, 503);
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "That conversation is too long to send. Start a new one." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Send JSON: { request }." }, 400);
  }
  const parsed = LlmRequestSchema.safeParse((body as { request?: unknown } | null)?.request);
  if (!parsed.success) return json({ error: "That turn is not in the shape AG Studio sends.", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);

  const wait = turnLimiter().take(await sessionKey());
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    return json({ error: `The assistant has answered a lot in the last few minutes. Try again in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? "s" : ""}.` }, 429, { "Retry-After": String(seconds) });
  }
  try {
    return json({ response: await runTurn(parsed.data, req.signal) }, 200);
  } catch (err) {
    console.error("insights llm turn failed:", safeError(err));
    return json({ error: `Gemini did not answer: ${safeError(err)}` }, 502);
  }
}
