// The Render cron job in render.yaml runs this every hour. It asks the web
// service to renew the deposit holds that are due; the web service runs the
// sweep as a Render Workflows task when it is set up for one, and in its own
// process otherwise (Render Workflows has no scheduler of its own yet).
//
// Once a day, on the run in the DEMO_RESET_HOUR (UTC, default 20), it also
// asks the web service to reset the demo (POST /api/jobs/reset-demo). The web
// service only resets when its own DEMO_RESET is "true", at most once a day,
// and never with live PayPal; otherwise it answers that the reset is off.
//
// Plain Node with no dependencies, so the cron service needs no build. It
// exits non-zero when the sweep fails, PayPal refuses a renewal, the web
// service had to renew in its own process because the workflow's PayPal
// settings differ from its own, or a reset it asked for failed or was
// refused. That marks the run failed in the dashboard and triggers Render's
// notification.
//
//   HANDBACK_HOSTPORT  the web service on Render's private network (render.yaml), or
//   HANDBACK_URL       any base URL, e.g. https://handback.onrender.com
//   CRON_SECRET        the web service's generated secret (render.yaml)
//   DEMO_RESET_HOUR    the reset hour in UTC, 0 to 23 (render.yaml copies the web service's)

import { parseResetHour, resetDueAt } from "./demo-reset-hour.mjs";

const base = process.env.HANDBACK_URL || (process.env.HANDBACK_HOSTPORT ? `http://${process.env.HANDBACK_HOSTPORT}` : "");
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error("Set HANDBACK_HOSTPORT (or HANDBACK_URL) and CRON_SECRET; render.yaml wires both from the web service.");
  process.exit(1);
}

/** POSTs to one of the web service's job routes; a network failure comes back as status 0. */
async function post(path) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, ok: false, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

let failed = false;

const renewal = await post("/api/jobs/renew-holds");
console.log(`HTTP ${renewal.status} ${JSON.stringify(renewal.body)}`);
if (renewal.body.warning) console.error(`The web service ran the sweep itself, but: ${renewal.body.warning}`);
if (!renewal.ok || renewal.body.ok !== true || renewal.body.failed > 0 || renewal.body.warning) failed = true;

const { hour, valid } = parseResetHour(process.env.DEMO_RESET_HOUR);
if (!valid) console.error(`DEMO_RESET_HOUR="${process.env.DEMO_RESET_HOUR}" is not an hour from 0 to 23; using ${hour}.`);
if (resetDueAt(new Date(), hour)) {
  const reset = await post("/api/jobs/reset-demo");
  console.log(`Demo reset: HTTP ${reset.status} ${JSON.stringify(reset.body)}`);
  if (!reset.ok || reset.body.ok !== true) {
    console.error(`The demo reset did not run: ${reset.body.error ?? reset.body.reason ?? `HTTP ${reset.status}`}`);
    failed = true;
  }
}

if (failed) process.exit(1);
