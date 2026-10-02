import "server-only";
import { getDb } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { paypalConfig } from "@/lib/paypal/config";
import { appendEvent } from "@/lib/rentals/audit";
import { renewDueHolds, type RenewalOutcome } from "@/lib/rentals/jobs";
import { eventsFor } from "@/lib/rentals/repo";
import { inspect } from "@/lib/rentals/service";
import { UserError } from "@/lib/rentals/types";
import { inspectionRunKey, renewalRunKey, TASKS } from "./config";
import type { InspectionJobResult, RenewalJobResult } from "./jobs";
import { renderRunner, waitForRun, type TaskRunner } from "./runner";

/** Three attempts of the task's 3-minute timeout, plus Render's backoff between them. */
const INSPECTION_WAIT_MS = 10 * 60_000;
/** The cron job waits for the sweep; a slower sweep keeps going and shows up in the next answer. */
const RENEWAL_WAIT_MS = 4 * 60_000;

/**
 * "Compare the photos" at the counter. With Render Workflows the comparison
 * runs as an inspect-return task and this request waits for it; otherwise,
 * or if Render cannot be reached, it runs right here. The task writes the
 * result to the database itself, so this process only tells open pages.
 */
export async function runInspection(rentalId: string, runner: TaskRunner | null = renderRunner()): Promise<void> {
  if (!runner) return inspect(rentalId);
  const db = await getDb();
  const failedRuns = new Set(
    (await eventsFor(db, rentalId)).filter((e) => e.type === "inspection.failed").map((e) => String(e.data.taskRunId)),
  );

  let taskRunId: string;
  try {
    taskRunId = await runner.start(TASKS.inspectReturn, [rentalId], inspectionRunKey(rentalId, failedRuns.size));
  } catch (err) {
    // The counter has to keep working while Render is unreachable or misconfigured; the log says why.
    console.error(`Render Workflows did not start ${TASKS.inspectReturn} for ${rentalId}; comparing in the web process.`, err);
    return inspect(rentalId);
  }

  const outcome = await waitForRun<InspectionJobResult>(runner, taskRunId, INSPECTION_WAIT_MS);
  if (outcome.kind === "done") {
    if (outcome.result?.status === "refused") throw new UserError(outcome.result.message);
    publish(rentalId, "inspection.completed");
    return;
  }
  if (outcome.kind === "running") {
    throw new UserError(`The comparison is still running on Render Workflows (run ${taskRunId}). Reload this page in a minute.`);
  }
  if (!failedRuns.has(taskRunId)) {
    await appendEvent(db, rentalId, "system", "inspection.failed", {
      worker: "render-workflows",
      taskRunId,
      attempts: outcome.attempts,
      error: outcome.error.slice(0, 300),
    });
    publish(rentalId, "inspection.failed");
  }
  const tries = outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : "";
  throw new UserError(
    `The photo comparison failed${tries} on Render Workflows (run ${taskRunId}). Nothing was charged. Try again, or compare the photos by eye.`,
  );
}

export type RenewalRun = {
  ranOn: "web" | "render-workflows";
  taskRunId?: string;
  /** The sweep was still running when the wait ran out; its renewals land in the audit log as usual. */
  pending?: boolean;
  results: RenewalOutcome[];
};

/**
 * The hold-renewal sweep behind POST /api/jobs/renew-holds. It runs as a
 * renew-holds task when Render Workflows is set up, and here otherwise. Demo
 * holds always renew here: the PayPal stand-in's state lives in this process.
 */
export async function runRenewals(now = new Date(), runner: TaskRunner | null = renderRunner()): Promise<RenewalRun> {
  if (!runner || paypalConfig().mode === "demo") return { ranOn: "web", results: await renewDueHolds(now) };

  let taskRunId: string;
  try {
    taskRunId = await runner.start(TASKS.renewHolds, [], renewalRunKey(now));
  } catch (err) {
    console.error(`Render Workflows did not start ${TASKS.renewHolds}; renewing in the web process.`, err);
    return { ranOn: "web", results: await renewDueHolds(now) };
  }

  const outcome = await waitForRun<RenewalJobResult>(runner, taskRunId, RENEWAL_WAIT_MS);
  if (outcome.kind === "running") return { ranOn: "render-workflows", taskRunId, pending: true, results: [] };
  if (outcome.kind === "failed") {
    throw new Error(`Render Workflows run ${taskRunId} failed after ${outcome.attempts} attempt(s): ${outcome.error}`);
  }
  if (outcome.result.status === "skipped") {
    throw new Error(
      `Render Workflows run ${taskRunId} skipped the sweep: ${outcome.result.reason} The workflow and the web service disagree about PayPal mode; give them the same PayPal settings.`,
    );
  }
  for (const r of outcome.result.results) if (r.outcome === "renewed") publish(r.rentalId, "deposit.reauthorized");
  return { ranOn: "render-workflows", taskRunId, results: outcome.result.results };
}
