import "server-only";
import { randomUUID } from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { DEFAULT_VISION_MODEL } from "@/lib/inspection/compare";
import { fromGeminiResponse, toGeminiRequest, type LlmRequest, type LlmResponse } from "./gemini";

/**
 * The server half of the dashboard's agent: AG Studio runs the agent loop in
 * the browser and hands each turn to /api/insights/llm, which calls Gemini
 * here with the key that never leaves the server.
 */

type Env = Record<string, string | undefined>;

/** Whether the dashboard's agent can run: it needs GEMINI_API_KEY on the server. The dashboard itself does not. */
export const insightsAiConfigured = (env: Env = process.env) => Boolean(env.GEMINI_API_KEY?.trim());

export const insightsModel = (env: Env = process.env) => env.AI_MODEL || DEFAULT_VISION_MODEL;

const TIMEOUT_MS = 60_000;

let client: { key: string; ai: GoogleGenAI } | undefined;
function ai(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (client?.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
}

export type TurnRunner = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse>;

/** One turn on Gemini. Thinking stays low: Studio runs many short turns per request. */
export const runTurn: TurnRunner = async (req, signal) => {
  const { contents, config, wrapped } = toGeminiRequest(req);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await ai().models.generateContent({
    model: insightsModel(),
    contents,
    config: { ...config, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout },
  });
  return fromGeminiResponse(res, wrapped, () => randomUUID().slice(0, 12));
};

/**
 * Keeps a provider error useful without echoing anything secret: the key is
 * cut out wherever it appears, and the message is shortened.
 */
export function safeError(err: unknown, env: Env = process.env): string {
  let text = err instanceof Error ? err.message : String(err);
  const key = env.GEMINI_API_KEY?.trim();
  if (key) text = text.split(key).join("[key]");
  text = text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]").replace(/([?&]key=)[^&\s"]+/g, "$1[key]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// ─── Rate limit ──────────────────────────────────────────────

export const LLM_WINDOW_MS = 10 * 60_000;
/** Model turns one staff session may ask for per window: a dashboard request takes several (delegations, tools). */
export const LLM_PER_SESSION = 60;
/** Turns from everyone together per window, as a ceiling on spend. */
export const LLM_GLOBAL = 300;

/** Counts turns per session and in total over a sliding window, in this process (the app runs as one instance). */
export function createTurnLimiter(perSession = LLM_PER_SESSION, global = LLM_GLOBAL, windowMs = LLM_WINDOW_MS) {
  const sessions = new Map<string, number[]>();
  let all: number[] = [];
  const recent = (times: number[], now: number) => times.filter((t) => now - t < windowMs);
  return {
    /** Records a turn and returns 0, or the milliseconds to wait when over a limit (nothing is recorded then). */
    take(session: string, now = Date.now()): number {
      const own = recent(sessions.get(session) ?? [], now);
      all = recent(all, now);
      if (own.length >= perSession) return own[0] + windowMs - now;
      if (all.length >= global) return all[0] + windowMs - now;
      own.push(now);
      all.push(now);
      sessions.set(session, own);
      if (sessions.size > 5_000) for (const [k, v] of sessions) if (recent(v, now).length === 0) sessions.delete(k);
      return 0;
    },
  };
}

const globalForLimiter = globalThis as unknown as { handbackInsightsTurns?: ReturnType<typeof createTurnLimiter> };
export const turnLimiter = () => (globalForLimiter.handbackInsightsTurns ??= createTurnLimiter());
