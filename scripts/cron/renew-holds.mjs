// The Render cron job in render.yaml runs this every hour. It asks the web
// service to renew the deposit holds that are due; the web service runs the
// sweep as a Render Workflows task when it is set up for one, and in its own
// process otherwise (Render Workflows has no scheduler of its own yet).
//
// Plain Node with no dependencies, so the cron service needs no build. It
// exits non-zero when the sweep fails or PayPal refuses a renewal, which marks
// the run failed in the dashboard and triggers Render's notification.
//
//   HANDBACK_HOSTPORT  the web service on Render's private network (render.yaml), or
//   HANDBACK_URL       any base URL, e.g. https://handback.onrender.com
//   CRON_SECRET        the web service's generated secret (render.yaml)

const base = process.env.HANDBACK_URL || (process.env.HANDBACK_HOSTPORT ? `http://${process.env.HANDBACK_HOSTPORT}` : "");
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error("Set HANDBACK_HOSTPORT (or HANDBACK_URL) and CRON_SECRET; render.yaml wires both from the web service.");
  process.exit(1);
}

const res = await fetch(`${base.replace(/\/$/, "")}/api/jobs/renew-holds`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(5 * 60_000),
});
const body = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status} ${JSON.stringify(body)}`);
if (!res.ok || body.ok !== true || body.failed > 0) process.exit(1);
