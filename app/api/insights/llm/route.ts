import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { LlmRequestSchema } from "@/lib/insights/gemini";
import { agentRefusal, runTurn, safeError, tokenBudget, turnLimiter } from "@/lib/insights/llm";
import { clientAddress, STAFF_COOKIE, staffAccessCode, staffOnlyResponse } from "@/lib/staff-access";

/**
 * One model turn for AG Studio's agents on the owner's dashboard. Studio runs
 * the agent loop in the browser; its adapter posts each turn here, and this
 * route calls Gemini with the server's key, which never reaches the browser.
 *
 * Staff only. Refused without a Gemini key, and on a counter without an
 * access code unless the request comes from this machine. A turn must have
 * the shape and size Studio sends (lib/insights/gemini.ts), its answer is
 * capped, turns are limited per client, and every token Gemini reports
 * counts against an hourly and a daily budget.
 */

/** Bytes. The largest turn measured in a demo session was 80 KB. */
const MAX_BODY = 400_000;

const json = (body: unknown, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });

/**
 * Who the turn counts against: the client address, under the same proxy
 * rules as the sign-in limits, and the staff cookie as well when the counter
 * has a code (staffOnlyResponse has checked it by then). A made-up cookie
 * therefore cannot buy a fresh allowance.
 */
async function sessionKey(address: string): Promise<string> {
  const cookie = staffAccessCode() ? (await cookies()).get(STAFF_COOKIE)?.value : undefined;
  return createHash("sha256")
    .update(`ip:${address}|cookie:${cookie ?? ""}`)
    .digest("base64url");
}

/** Reads the body up to `limit` bytes; null when it is longer. */
async function readLimited(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const minutes = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
};

export async function POST(req: Request) {
  const refused = await staffOnlyResponse();
  if (refused) return refused;
  const address = await clientAddress();
  const off = agentRefusal(address);
  if (off) return json({ error: off }, off.includes("GEMINI_API_KEY") ? 503 : 403);

  const tooLong = json({ error: "That conversation is too long to send. Start a new one." }, 413);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return tooLong;
  const text = await readLimited(req, MAX_BODY);
  if (text === null) return tooLong;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Send JSON: { request }." }, 400);
  }
  const parsed = LlmRequestSchema.safeParse((body as { request?: unknown } | null)?.request);
  if (!parsed.success) return json({ error: "That turn is not in the shape AG Studio sends.", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);

  const budget = tokenBudget();
  const spent = budget.waitMs();
  if (spent > 0) {
    return json({ error: `The assistant has used its Gemini allowance for now. It can answer again in ${minutes(spent)}.` }, 429, { "Retry-After": String(Math.ceil(spent / 1000)) });
  }
  const wait = turnLimiter().take(await sessionKey(address));
  if (wait > 0) {
    return json({ error: `The assistant has answered a lot in the last few minutes. Try again in ${minutes(wait)}.` }, 429, { "Retry-After": String(Math.ceil(wait / 1000)) });
  }
  try {
    const response = await runTurn(parsed.data, req.signal);
    budget.spend(response.usage ? (response.usage.totalTokens ?? response.usage.inputTokens + response.usage.outputTokens) : 0);
    return json({ response }, 200);
  } catch (err) {
    console.error("insights llm turn failed:", safeError(err));
    return json({ error: `Gemini did not answer: ${safeError(err)}` }, 502);
  }
}
