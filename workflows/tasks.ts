import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { TASKS, type JobModes } from "@/lib/workflows/config";
import { inspectReturnJob, renewHoldsJob } from "@/lib/workflows/jobs";

/**
 * Two independent Gemini looks at one rental's pickup and return photos,
 * then the deterministic price policy and the agreement rule. Each look can
 * take up to 60 s plus one repair turn, so a run gets 3 minutes; a failed run
 * is retried twice, 5 s and then 10 s later. The default `flex` plan is
 * enough: the work is two HTTPS calls and two small JPEGs. Input:
 * `[rentalId, webModes]`, where webModes are the web service's PayPal and AI
 * modes; a run started from the dashboard can leave them out.
 */
export const inspectReturn = task(
  {
    name: TASKS.inspectReturn,
    timeoutSeconds: 180,
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  async function inspectReturn(ctx: TaskContext, rentalId: string, webModes?: JobModes) {
    const result = await inspectReturnJob(rentalId, ctx.metadata.taskRunId ?? null, webModes);
    if (result.status === "skipped") console.error(`${TASKS.inspectReturn} ${rentalId}: skipped. ${result.reason}`);
    else console.log(`${TASKS.inspectReturn} ${rentalId}: ${result.status}`);
    return result;
  },
);

/**
 * Renews deposit holds that are due (the day before the item comes back,
 * never before day 4). Input: `[webModes]`, or nothing from the dashboard.
 */
export const renewHolds = task(
  {
    name: TASKS.renewHolds,
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 10_000, backoffScaling: 2 },
  },
  async function renewHolds(_ctx: TaskContext, webModes?: JobModes) {
    const result = await renewHoldsJob(new Date(), webModes);
    if (result.status === "skipped") console.error(`${TASKS.renewHolds}: skipped. ${result.reason}`);
    else for (const r of result.results) console.log(`${TASKS.renewHolds} ${r.rentalId}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
    return result;
  },
);
