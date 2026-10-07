import { resetDemo } from "@/lib/demo-reset/reset";

export const dynamic = "force-dynamic";

/**
 * The nightly demo reset (lib/demo-reset/reset.ts). Called by the Render cron
 * job (scripts/cron/renew-holds.mjs) once a day, in the DEMO_RESET_HOUR, with
 * `Authorization: Bearer $CRON_SECRET`. It deletes every rental, so it does
 * nothing unless DEMO_RESET is "true" on this service, refuses live PayPal
 * (403), and runs at most once per reset day: a second call answers
 * `"status": "already-done"`.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await resetDemo();
    if (result.status === "refused") return Response.json({ ok: false, ...result }, { status: 403 });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
