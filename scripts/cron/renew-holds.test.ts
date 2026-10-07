// The cron job's script, run as Render runs it (plain Node), against a local
// server that answers like POST /api/jobs/renew-holds and, once a day, POST
// /api/jobs/reset-demo. Its exit code is what marks a cron run failed in the
// Render dashboard.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./renew-holds.mjs", import.meta.url));

type Seen = { method?: string; url?: string; authorization?: string };

let answer: { status: number; body: unknown } = { status: 200, body: {} };
let resetAnswer: { status: number; body: unknown } = { status: 200, body: {} };
let seen: Seen = {};
let resets: Seen[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const request = { method: req.method, url: req.url, authorization: req.headers.authorization };
    const reply = req.url === "/api/jobs/reset-demo" ? (resets.push(request), resetAnswer) : ((seen = request), answer);
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

function cron(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Only what the test passes: the cron job sees nothing of this process's environment.
    const only: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "production", ...env };
    execFile(process.execPath, [SCRIPT], { env: only, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

const run = (status: number, body: unknown) => {
  answer = { status, body };
  return cron({ HANDBACK_URL: `${base}/`, CRON_SECRET: "cron-test-secret", DEMO_RESET_HOUR: String(otherHour()) });
};

/** An hour the reset is never due in while the test runs. */
const otherHour = () => (new Date().getUTCHours() + 12) % 24;

/** The current UTC hour, after waiting out the last seconds of an hour so the script sees the same one. */
async function thisHour(): Promise<number> {
  const now = new Date();
  if (now.getUTCMinutes() === 59 && now.getUTCSeconds() >= 50) await new Promise((r) => setTimeout(r, 11_000));
  return new Date().getUTCHours();
}

const swept = { ok: true, ranOn: "render-workflows", taskRunId: "trn-1", pending: false, warning: null, renewed: 1, failed: 0, results: [] };

describe("scripts/cron/renew-holds.mjs", () => {
  it("posts with the cron secret and succeeds when the sweep went through", async () => {
    const result = await run(200, swept);
    expect(seen).toEqual({ method: "POST", url: "/api/jobs/renew-holds", authorization: "Bearer cron-test-secret" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTTP 200 {"ok":true,"ranOn":"render-workflows"');
  });

  it("succeeds while a slow sweep is still running", async () => {
    expect((await run(200, { ...swept, pending: true, renewed: 0 })).code).toBe(0);
  });

  it("fails when PayPal refused a renewal", async () => {
    expect((await run(200, { ...swept, failed: 1 })).code).toBe(1);
  });

  it("fails, saying why, when the web service had to sweep because the workflow's settings differ", async () => {
    const warning = "Render Workflows run trn-1 skipped the sweep: the workflow service runs in \"demo\".";
    const result = await run(200, { ...swept, ranOn: "web", warning });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`The web service ran the sweep itself, but: ${warning}`);
  });

  it("fails when the sweep failed or the secret was wrong", async () => {
    expect((await run(502, { ok: false, error: "Render Workflows run trn-1 failed" })).code).toBe(1);
    expect((await run(401, { error: "unauthorized" })).code).toBe(1);
  });

  it("asks for no demo reset outside the reset hour", async () => {
    resets = [];
    expect((await run(200, swept)).code).toBe(0);
    expect(resets).toEqual([]);
  });

  it("fails without a place to call or a secret", async () => {
    const result = await cron({ CRON_SECRET: "cron-test-secret" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Set HANDBACK_HOSTPORT (or HANDBACK_URL) and CRON_SECRET");
  });
});

describe("the daily demo reset", () => {
  const reset = async (env: Record<string, string>, renewal: { status: number; body: unknown } = { status: 200, body: swept }) => {
    answer = renewal;
    resets = [];
    seen = {};
    return cron({ HANDBACK_URL: base, CRON_SECRET: "cron-test-secret", ...env });
  };
  const done = { ok: true, status: "reset", day: "2026-11-20", mode: "demo", deletedRentals: 12, released: [], seeded: { counter: 6, schedule: 26 } };

  it("in the reset hour, renews holds and then asks for the reset with the same secret", async () => {
    resetAnswer = { status: 200, body: done };
    const result = await reset({ DEMO_RESET_HOUR: String(await thisHour()) });
    expect(seen.url).toBe("/api/jobs/renew-holds");
    expect(resets).toEqual([{ method: "POST", url: "/api/jobs/reset-demo", authorization: "Bearer cron-test-secret" }]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Demo reset: HTTP 200 {"ok":true,"status":"reset"');
  });

  it("succeeds when the web service has the reset off, or already reset today", async () => {
    const hour = String(await thisHour());
    resetAnswer = { status: 200, body: { ok: true, status: "off", reason: "DEMO_RESET is not true on this service, so nothing was reset." } };
    expect((await reset({ DEMO_RESET_HOUR: hour })).code).toBe(0);
    resetAnswer = { status: 200, body: { ok: true, status: "already-done", day: "2026-11-20", state: "done" } };
    expect((await reset({ DEMO_RESET_HOUR: hour })).code).toBe(0);
    expect(resets).toHaveLength(1);
  });

  it("fails, saying why, when the reset was refused or failed", async () => {
    const hour = String(await thisHour());
    resetAnswer = { status: 403, body: { ok: false, status: "refused", reason: "PAYPAL_ENVIRONMENT is live." } };
    const refused = await reset({ DEMO_RESET_HOUR: hour });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("The demo reset did not run: PAYPAL_ENVIRONMENT is live.");
    resetAnswer = { status: 500, body: { ok: false, error: "truncate failed" } };
    const failed = await reset({ DEMO_RESET_HOUR: hour });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("The demo reset did not run: truncate failed");
  });

  it("still asks for the reset when the renewal sweep failed, and reports the failure", async () => {
    resetAnswer = { status: 200, body: done };
    const result = await reset({ DEMO_RESET_HOUR: String(await thisHour()) }, { status: 200, body: { ...swept, failed: 1 } });
    expect(resets).toHaveLength(1);
    expect(result.code).toBe(1);
  });

  it("uses 20 UTC when DEMO_RESET_HOUR is not an hour, and says so", async () => {
    resetAnswer = { status: 200, body: done };
    const hour = await thisHour();
    const result = await reset({ DEMO_RESET_HOUR: "8pm" });
    expect(result.stderr).toContain('DEMO_RESET_HOUR="8pm" is not an hour from 0 to 23; using 20.');
    expect(resets).toHaveLength(hour === 20 ? 1 : 0);
  });
});
