import { runRenewals } from "@/lib/workflows/dispatch";

export const dynamic = "force-dynamic";

/**
 * Renews deposit holds that are due (see renewalDueAt). Called by the Render
 * cron job (scripts/cron/renew-holds.mjs) with `Authorization: Bearer
 * $CRON_SECRET`. The sweep runs as a Render Workflows task when the
 * deployment is set up for it, in this process otherwise. Idempotent, so
 * running it hourly or daily is equally safe.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const run = await runRenewals();
    const count = (outcome: string) => run.results.filter((r) => r.outcome === outcome).length;
    return Response.json({
      ok: true,
      ranOn: run.ranOn,
      taskRunId: run.taskRunId ?? null,
      pending: run.pending ?? false,
      renewed: count("renewed"),
      failed: count("failed"),
      results: run.results,
    });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
