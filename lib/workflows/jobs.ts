import "server-only";
import { getDb } from "@/lib/db/client";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig } from "@/lib/paypal/config";
import { renewDueHolds, type RenewalOutcome } from "@/lib/rentals/jobs";
import { latestAssessment, rentalById } from "@/lib/rentals/repo";
import { inspect } from "@/lib/rentals/service";
import { UserError } from "@/lib/rentals/types";
import { databaseMissing, modeMismatch, type JobModes } from "./config";

// The bodies of the Render Workflows tasks in workflows/tasks.ts. They only call
// the rental service; the business rules stay in lib/rentals and lib/inspection.
// Return values are plain JSON, because Render stores and returns them as JSON.

/** This process's PayPal and AI modes. The web service sends its own with each run. */
export function jobModes(): JobModes {
  return { paypal: paypalConfig().mode, ai: aiConfigured() ? "gemini" : "recorded-replies" };
}

export type InspectionJobResult =
  | { status: "inspected"; assessmentId: string }
  | { status: "already-inspected"; assessmentId: string }
  /** The rental is not in a state to compare (no return photo, wrong step): retrying cannot help. */
  | { status: "refused"; message: string }
  /** This workflow's AI mode differs from the web service's, so nothing was compared. */
  | { status: "skipped"; reason: string };

/** The assessment written by an earlier attempt, if the comparison already went through. */
async function finishedInspection(rentalId: string): Promise<string | null> {
  const db = await getDb();
  const rental = await rentalById(db, rentalId);
  if (rental?.status !== "inspecting") return null;
  return (await latestAssessment(db, rentalId))?.id ?? null;
}

/**
 * Compares a returned rental's photos, at most once. Render retries a run
 * whose attempt crashed or timed out; an attempt that finds the comparison
 * already saved returns it instead of asking Gemini again. Problems a person
 * has to fix come back as `refused` rather than as an error, so Render does
 * not retry them. Anything else (Gemini down, a reply that failed validation
 * twice, the database unreachable) is thrown and retried. A run with no
 * DATABASE_URL on the workflow service compares nothing (databaseMissing). When the web
 * service's AI mode (`web`) differs from this process's, the task compares
 * nothing: a workflow without the Gemini key would quietly save recorded
 * replies, or none, for photos the web service expects Gemini to look at.
 */
export async function inspectReturnJob(rentalId: string, taskRunId: string | null, web?: unknown): Promise<InspectionJobResult> {
  const noDatabase = databaseMissing();
  if (noDatabase) return { status: "skipped", reason: noDatabase };
  const mismatch = modeMismatch(web, jobModes(), "ai");
  if (mismatch) return { status: "skipped", reason: mismatch };
  const done = await finishedInspection(rentalId);
  if (done) return { status: "already-inspected", assessmentId: done };
  try {
    await inspect(rentalId, { worker: "render-workflows", taskRunId });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    const raced = await finishedInspection(rentalId);
    return raced ? { status: "already-inspected", assessmentId: raced } : { status: "refused", message: err.message };
  }
  const assessment = await latestAssessment(await getDb(), rentalId);
  if (!assessment) throw new Error(`no assessment saved for ${rentalId}`);
  return { status: "inspected", assessmentId: assessment.id };
}

export type RenewalJobResult = { status: "swept"; results: RenewalOutcome[] } | { status: "skipped"; reason: string };

/**
 * The hold-renewal sweep. A PayPal refusal for one rental is recorded on that
 * rental and reported in the results, not thrown: retrying the whole sweep
 * would not change PayPal's answer. Crashes and database errors are thrown so
 * Render retries; renewals that already went through are not repeated, since
 * a renewed hold is no longer due and the PayPal request id is per rental per day.
 * The sweep is skipped when the web service's PayPal mode (`web`) differs
 * from this process's, or when this process has only the demo stand-in.
 */
export async function renewHoldsJob(now = new Date(), web?: unknown): Promise<RenewalJobResult> {
  const noDatabase = databaseMissing();
  if (noDatabase) return { status: "skipped", reason: noDatabase };
  const mismatch = modeMismatch(web, jobModes(), "paypal");
  if (mismatch) return { status: "skipped", reason: mismatch };
  if (paypalConfig().mode === "demo") {
    return {
      status: "skipped",
      reason: "PayPal is in demo mode. The stand-in keeps its state in the web process, so the web service renews demo holds itself.",
    };
  }
  return { status: "swept", results: await renewDueHolds(now) };
}
