import type { PayPalMode } from "@/lib/paypal/config";

/**
 * Where background work runs. On Render, the web app hands the two-look photo
 * inspection and the hold-renewal sweep to Render Workflows, which runs each
 * one on its own instance with retries. Without that wiring (local dev, demo
 * clones, tests) the same functions run inside the web process, so nothing in
 * the rental flow depends on Render.
 */

/** Task names as registered in workflows/tasks.ts. Render task slugs are `<workflow slug>/<name>`. */
export const TASKS = {
  inspectReturn: "inspect-return",
  renewHolds: "renew-holds",
} as const;

export type TaskName = (typeof TASKS)[keyof typeof TASKS];

export type WorkflowsConfig =
  | { runner: "inline"; reason: string }
  | { runner: "render"; slug: string | null; local: boolean };

const TRUTHY = new Set(["1", "t", "T", "true", "TRUE", "True"]);

/**
 * Render Workflows is used when the Blueprint has wired in the workflow's
 * slug and someone has added a Render API key, or when RENDER_USE_LOCAL_DEV
 * points the SDK at `render workflows dev`. RENDER_WORKFLOWS=off forces the
 * web process to do the work even then.
 */
export function workflowsConfig(env: Record<string, string | undefined> = process.env): WorkflowsConfig {
  if (env.RENDER_WORKFLOWS === "off") return { runner: "inline", reason: "RENDER_WORKFLOWS is off" };
  const slug = env.RENDER_WORKFLOW_SLUG?.trim() || null;
  const local = TRUTHY.has(env.RENDER_USE_LOCAL_DEV ?? "") || Boolean(env.RENDER_LOCAL_DEV_URL);
  if (local) return { runner: "render", slug, local: true };
  if (!slug) return { runner: "inline", reason: "RENDER_WORKFLOW_SLUG is not set" };
  if (!env.RENDER_API_KEY) return { runner: "inline", reason: "RENDER_API_KEY is not set" };
  return { runner: "render", slug, local: false };
}

/** The identifier Render expects when starting a run; the local task server also accepts the bare name. */
export function taskIdentifier(slug: string | null, task: TaskName): string {
  return slug ? `${slug}/${task}` : task;
}

/**
 * Idempotency key for comparing one rental's photos. A double tap, a second
 * tab or a retried request reuses the key and so joins the run already going.
 * Render remembers a key for 24 hours, including a failed run, so the key
 * moves on once a failed run is on record and "Compare" can be pressed again.
 * Keys only hold within one workflow version: after a deploy the same key
 * starts a new run, and the row lock in inspect() keeps it to one assessment.
 */
export function inspectionRunKey(rentalId: string, failedRuns: number): string {
  return `inspect-${rentalId}-${failedRuns}`;
}

/** One renewal sweep per clock hour, however often the cron job asks. */
export function renewalRunKey(now: Date): string {
  return `renew-holds-${now.toISOString().slice(0, 13)}`;
}

/**
 * The PayPal and AI modes a process runs in. The web service and the workflow
 * service each get their PayPal and Gemini settings separately (render.yaml),
 * so the web service sends its modes with every run and a task checks them
 * against its own before doing anything.
 */
export type JobModes = { paypal: PayPalMode; ai: "gemini" | "recorded-replies" };

const MODE_FIX: Record<keyof JobModes, string> = {
  paypal: "Give the workflow service the same PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENVIRONMENT as the web service.",
  ai: "Give the workflow service the same GEMINI_API_KEY as the web service.",
};

/**
 * Why a task should not run here: the web service's mode for `key`, as sent
 * in the run's input, differs from this process's. Null when they agree, or
 * when the run carries no modes (started from the dashboard, say).
 */
export function modeMismatch(web: unknown, own: JobModes, key: keyof JobModes): string | null {
  const expected = typeof web === "object" && web !== null ? (web as Record<string, unknown>)[key] : undefined;
  if (typeof expected !== "string" || expected === own[key]) return null;
  const what = key === "paypal" ? "PayPal mode" : "AI mode";
  return `The web service runs in ${what} "${expected}", but the workflow service runs in "${own[key]}". ${MODE_FIX[key]}`;
}

export type SkippedRun = { task: TaskName; taskRunId: string; reason: string; at: string };

const globalForRuns = globalThis as unknown as { handbackSkippedRun?: SkippedRun };

/** Remembers the latest run a task skipped because of a mode mismatch, for /api/health. */
export function noteSkippedRun(run: Omit<SkippedRun, "at">, now = new Date()): void {
  globalForRuns.handbackSkippedRun = { ...run, at: now.toISOString() };
}

/** The latest run skipped since this process started, or null. */
export function lastSkippedRun(): SkippedRun | null {
  return globalForRuns.handbackSkippedRun ?? null;
}

export type RunSnapshot = { id: string; status: string; results?: unknown[]; error?: string; retries?: number };

export type RunOutcome<T> =
  | { kind: "done"; taskRunId: string; result: T }
  | { kind: "failed"; taskRunId: string; error: string; attempts: number }
  | { kind: "running"; taskRunId: string };

/** Reads a task run as Render reports it. A finished run's return value is the first entry of `results`. */
export function runOutcome<T>(run: RunSnapshot): RunOutcome<T> {
  switch (run.status) {
    case "completed":
    case "succeeded":
      return { kind: "done", taskRunId: run.id, result: run.results?.[0] as T };
    case "failed":
    case "canceled":
      return {
        kind: "failed",
        taskRunId: run.id,
        error: run.error?.trim() || (run.status === "canceled" ? "The run was canceled." : "The run failed."),
        attempts: (run.retries ?? 0) + 1,
      };
    default:
      return { kind: "running", taskRunId: run.id };
  }
}
