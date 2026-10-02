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
 */
export function inspectionRunKey(rentalId: string, failedRuns: number): string {
  return `inspect-${rentalId}-${failedRuns}`;
}

/** One renewal sweep per clock hour, however often the cron job asks. */
export function renewalRunKey(now: Date): string {
  return `renew-holds-${now.toISOString().slice(0, 13)}`;
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
