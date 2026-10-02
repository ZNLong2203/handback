// The cron job's script, run as Render runs it (plain Node), against a local
// server that answers like POST /api/jobs/renew-holds. Its exit code is what
// marks a cron run failed in the Render dashboard.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./renew-holds.mjs", import.meta.url));

let answer: { status: number; body: unknown } = { status: 200, body: {} };
let seen: { method?: string; url?: string; authorization?: string } = {};
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    seen = { method: req.method, url: req.url, authorization: req.headers.authorization };
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
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
  return cron({ HANDBACK_URL: `${base}/`, CRON_SECRET: "cron-test-secret" });
};

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

  it("fails without a place to call or a secret", async () => {
    const result = await cron({ CRON_SECRET: "cron-test-secret" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Set HANDBACK_HOSTPORT (or HANDBACK_URL) and CRON_SECRET");
  });
});
