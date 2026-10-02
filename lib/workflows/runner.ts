import "server-only";
import type { Render } from "@renderinc/sdk";
import { runOutcome, taskIdentifier, workflowsConfig, type RunOutcome, type RunSnapshot, type TaskName, type WorkflowsConfig } from "./config";

/** What the web app needs from Render Workflows: start a run idempotently, and read it back. */
export interface TaskRunner {
  start(task: TaskName, input: unknown[], idempotencyKey: string): Promise<string>;
  get(taskRunId: string): Promise<RunSnapshot>;
}

/**
 * Render Workflows through the official SDK (RENDER_API_KEY, or the local task
 * server when RENDER_USE_LOCAL_DEV is set), or null when jobs run inline.
 */
export function renderRunner(cfg: WorkflowsConfig = workflowsConfig()): TaskRunner | null {
  if (cfg.runner === "inline") return null;
  let client: Promise<Render["workflows"]> | undefined;
  const workflows = () => (client ??= import("@renderinc/sdk").then(({ Render }) => new Render().workflows));
  return {
    async start(task, input, idempotencyKey) {
      const run = await (await workflows()).startTask(taskIdentifier(cfg.slug, task), input, { idempotencyKey });
      return run.taskRunId;
    },
    async get(taskRunId) {
      return (await workflows()).getTaskRun(taskRunId);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls a run until it finishes or the wait runs out. Polling rather than
 * the SDK's event stream also covers a run that had already finished when an
 * idempotency key handed it back. A few failed reads in a row are tolerated.
 */
export async function waitForRun<T>(runner: TaskRunner, taskRunId: string, timeoutMs: number, pause = sleep): Promise<RunOutcome<T>> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  let errors = 0;
  for (;;) {
    try {
      const outcome = runOutcome<T>(await runner.get(taskRunId));
      errors = 0;
      if (outcome.kind !== "running") return outcome;
    } catch (err) {
      if (++errors >= 5) throw err;
    }
    if (Date.now() + delay > deadline) return { kind: "running", taskRunId };
    await pause(delay);
    delay = Math.min(Math.round(delay * 1.5), 3_000);
  }
}
