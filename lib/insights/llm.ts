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
/** A turn's answer: a message or a few tool calls. Studio's turns stay far below this. */
export const MAX_OUTPUT_TOKENS = 8_192;

let client: { key: string; ai: GoogleGenAI } | undefined;
function ai(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (client?.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
}

export type TurnRunner = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse>;

/** The generateContent call for one turn: the mapped request, a capped answer, low thinking (Studio runs many short turns). */
export function geminiParams(req: LlmRequest, signal?: AbortSignal) {
  const { contents, config, wrapped } = toGeminiRequest(req);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return {
    wrapped,
    params: {
      model: insightsModel(),
      contents,
      config: {
        ...config,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    },
  };
}

/** One turn on Gemini. */
export const runTurn: TurnRunner = async (req, signal) => {
  const { params, wrapped } = geminiParams(req, signal);
  const res = await ai().models.generateContent(params);
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

// ─── Who may use it ──────────────────────────────────────────

/** Loopback addresses as clientAddress reports them (Next sets X-Forwarded-For to the socket address without a proxy). */
export const isLoopback = (address: string) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/.test(address.trim());

/**
 * Why the agent cannot run for this request, or null when it can. It needs
 * a Gemini key, and the counter's access code: without SHOP_ACCESS_CODE the
 * counter is open to anyone who can reach it, so the agent then answers only
 * on this machine.
 */
export function agentRefusal(address: string, env: Env = process.env): string | null {
  if (!insightsAiConfigured(env)) return "The AI assistant needs a Gemini key: set GEMINI_API_KEY on the server. The dashboard works without it.";
  if (!env.SHOP_ACCESS_CODE && !isLoopback(address)) {
    return "The AI assistant is off because this counter has no access code: set SHOP_ACCESS_CODE, or open the dashboard on the machine that runs it. The dashboard works without it.";
  }
  return null;
}

// ─── Rate limit ──────────────────────────────────────────────

export const LLM_WINDOW_MS = 10 * 60_000;
/** Model turns one staff session may ask for per window: one "add a chart" request took 15 to 20 turns (delegations, tools). */
export const LLM_PER_SESSION = 120;
/** Turns from everyone together per window, as a ceiling on spend. */
export const LLM_GLOBAL = 400;

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

// ─── Token budget ────────────────────────────────────────────

/** Tokens (in and out, as Gemini reports them) the agent may use per hour and per day, across everyone. */
export const TOKENS_PER_HOUR = 2_000_000;
export const TOKENS_PER_DAY = 10_000_000;

/**
 * A ceiling on spend that a session limit cannot give: every turn's usage,
 * as Gemini reports it, counted over the last hour and the last day, in
 * this process. Over either, turns wait.
 */
export function createTokenBudget(perHour = TOKENS_PER_HOUR, perDay = TOKENS_PER_DAY) {
  let spent: { at: number; tokens: number }[] = [];
  const sum = (since: number) => spent.filter((s) => s.at > since).reduce((total, s) => total + s.tokens, 0);
  return {
    /** Milliseconds until a turn may run, or 0. */
    waitMs(now = Date.now()): number {
      spent = spent.filter((s) => s.at > now - 86_400_000);
      const waits: number[] = [];
      if (sum(now - 3_600_000) >= perHour) waits.push(firstAfter(now - 3_600_000, now) + 3_600_000 - now);
      if (sum(now - 86_400_000) >= perDay) waits.push(firstAfter(now - 86_400_000, now) + 86_400_000 - now);
      return waits.length ? Math.max(1, ...waits) : 0;
    },
    spend(tokens: number, now = Date.now()): void {
      if (tokens > 0) spent.push({ at: now, tokens });
    },
  };
  function firstAfter(since: number, now: number): number {
    return spent.find((s) => s.at > since)?.at ?? now;
  }
}

const globalForBudget = globalThis as unknown as { handbackInsightsTokens?: ReturnType<typeof createTokenBudget> };
export const tokenBudget = () => (globalForBudget.handbackInsightsTokens ??= createTokenBudget());
