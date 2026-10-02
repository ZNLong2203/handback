import { renewDueHolds } from "@/lib/rentals/jobs";

export const dynamic = "force-dynamic";

/**
 * Renews deposit holds that are due (see renewalDueAt). Called by a scheduled
 * job with `Authorization: Bearer $CRON_SECRET`; idempotent, so running it
 * hourly or daily is equally safe.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const results = await renewDueHolds();
  return Response.json({ ok: true, renewed: results.filter((r) => r.outcome === "renewed").length, results });
}
