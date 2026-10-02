import "server-only";
import { getDb } from "@/lib/db/client";
import { DEFAULT_VISION_MODEL } from "@/lib/inspection/compare";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig, type PayPalMode } from "@/lib/paypal/config";
import { lastSkippedRun, workflowsConfig, type SkippedRun } from "@/lib/workflows/config";

export type Health = {
  ok: boolean;
  database: { ok: boolean; driver: "postgres" | "pglite" | "memory"; ms: number; error?: string };
  paypal: { mode: PayPalMode; webhookConfigured: boolean };
  ai: { mode: "gemini" | "recorded-replies"; model: string | null };
  /**
   * paypal and ai are this web service's modes. A task run checks them against
   * the workflow's own and skips when they differ (the work then runs here);
   * lastSkippedRun is the latest such run since this process started.
   */
  jobs: { runner: "render-workflows"; slug: string | null; lastSkippedRun: SkippedRun | null } | { runner: "web"; reason: string };
  build: { commit: string | null; branch: string | null };
  checkedAt: string;
};

/** Render answers a health check in 5 seconds; leave room for the response. */
const DB_TIMEOUT_MS = 4_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function pingDatabase(): Promise<void> {
  const db = await getDb();
  await db.query("select 1");
}

/** Only an error code (ECONNREFUSED, 28P01, timeout): driver messages can carry host names. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "unreachable";
}

/**
 * What this deployment is running, for Render's health check and for anyone
 * deciding whether the demo is real: database reachable, PayPal mode, AI
 * mode, where background jobs run, and the deployed commit. Only modes and
 * booleans come from the environment; never a key, secret or URL.
 */
export async function checkHealth(ping: () => Promise<void> = pingDatabase): Promise<Health> {
  const env = process.env;
  const started = Date.now();
  let error: string | undefined;
  try {
    await withTimeout(ping(), DB_TIMEOUT_MS);
  } catch (err) {
    error = errorCode(err);
  }
  const url = env.DATABASE_URL;
  const paypal = paypalConfig();
  const ai = aiConfigured();
  const jobs = workflowsConfig();
  return {
    ok: !error,
    database: { ok: !error, driver: url === "memory" ? "memory" : url ? "postgres" : "pglite", ms: Date.now() - started, ...(error ? { error } : {}) },
    paypal: { mode: paypal.mode, webhookConfigured: Boolean(paypal.webhookId) },
    ai: { mode: ai ? "gemini" : "recorded-replies", model: ai ? env.AI_MODEL || DEFAULT_VISION_MODEL : null },
    jobs: jobs.runner === "render" ? { runner: "render-workflows", slug: jobs.slug, lastSkippedRun: lastSkippedRun() } : { runner: "web", reason: jobs.reason },
    build: { commit: env.RENDER_GIT_COMMIT || null, branch: env.RENDER_GIT_BRANCH || null },
    checkedAt: new Date().toISOString(),
  };
}
