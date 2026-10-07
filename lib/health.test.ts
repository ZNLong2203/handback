import { afterEach, describe, expect, it } from "vitest";
import { checkHealth } from "./health";
import { noteSkippedRun } from "./workflows/config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const SECRETS = {
  PAYPAL_CLIENT_ID: "client-id-value",
  PAYPAL_CLIENT_SECRET: "client-secret-value",
  PAYPAL_WEBHOOK_ID: "webhook-id-value",
  GEMINI_API_KEY: "gemini-key-value",
  RENDER_API_KEY: "render-key-value",
  CRON_SECRET: "cron-secret-value",
  SHOP_ACCESS_CODE: "shop-access-code-value",
  STAFF_COOKIE_SECRET: "staff-cookie-secret-value",
  DATABASE_URL: "postgresql://handback:db-password-value@dpg-example-a/handback",
};

describe("checkHealth", () => {
  it("reports what the deployment runs, and none of its secrets", async () => {
    Object.assign(process.env, SECRETS, {
      DEMO_MODE: "",
      PAYPAL_ENVIRONMENT: "sandbox",
      AI_MODEL: "",
      RENDER_WORKFLOW_SLUG: "handback-workflows",
      RENDER_GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      RENDER_GIT_BRANCH: "main",
    });
    const health = await checkHealth(async () => {});
    expect(health).toMatchObject({
      ok: true,
      database: { ok: true, driver: "postgres" },
      paypal: { mode: "sandbox", webhookConfigured: true },
      ai: { mode: "gemini", model: "gemini-3.8-flash" },
      jobs: { runner: "render-workflows", slug: "handback-workflows", lastSkippedRun: null },
      build: { commit: "0123456789abcdef0123456789abcdef01234567", branch: "main" },
      staffAccess: { mode: "code", signInLocked: false },
    });
    const body = JSON.stringify(health);
    for (const value of Object.values(SECRETS)) expect(body).not.toContain(value);
    expect(body).not.toContain("db-password-value");
  });

  it("shows the latest run the workflow skipped because its modes differ from this service's", async () => {
    Object.assign(process.env, SECRETS, { DEMO_MODE: "", RENDER_WORKFLOW_SLUG: "handback-workflows" });
    const reason = 'The web service runs in AI mode "gemini", but the workflow service runs in "recorded-replies".';
    noteSkippedRun({ task: "inspect-return", taskRunId: "trn-1", reason }, new Date("2026-11-20T09:17:00Z"));
    const health = await checkHealth(async () => {});
    expect(health).toMatchObject({ ok: true, ai: { mode: "gemini" } });
    expect(health.jobs).toEqual({
      runner: "render-workflows",
      slug: "handback-workflows",
      lastSkippedRun: { task: "inspect-return", taskRunId: "trn-1", reason, at: "2026-11-20T09:17:00.000Z" },
    });
  });

  it("fails on an unreachable database with a code, not the driver's message", async () => {
    Object.assign(process.env, { DATABASE_URL: "memory", DEMO_MODE: "true", RENDER_WORKFLOW_SLUG: "", RENDER_GIT_COMMIT: "" });
    const refused = await checkHealth(() => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432"), { code: "ECONNREFUSED" })));
    expect(refused).toMatchObject({ ok: false, database: { ok: false, driver: "memory", error: "ECONNREFUSED" } });
    const other = await checkHealth(() => Promise.reject(new Error("password authentication failed for user handback at dpg-secret-host")));
    expect(other.database.error).toBe("unreachable");
    expect(JSON.stringify(other)).not.toContain("dpg-secret-host");
    expect(other).toMatchObject({ paypal: { mode: "demo" }, ai: { mode: "recorded-replies", model: null }, jobs: { runner: "web" }, build: { commit: null } });
  });

  it("reports the nightly demo reset: off, or on with its hour and when it last ran", async () => {
    Object.assign(process.env, { DATABASE_URL: "memory", DEMO_RESET: "", DEMO_RESET_HOUR: "", PAYPAL_ENVIRONMENT: "sandbox" });
    let asked = 0;
    const lastReset = async () => (asked++, "2026-11-20T20:17:42.000Z");
    expect((await checkHealth(async () => {}, lastReset)).demoReset).toEqual({ enabled: false, hourUtc: 20, refused: null, lastResetAt: null });
    expect(asked).toBe(0);

    Object.assign(process.env, { DEMO_RESET: "true", DEMO_RESET_HOUR: "3" });
    expect((await checkHealth(async () => {}, lastReset)).demoReset).toEqual({ enabled: true, hourUtc: 3, refused: null, lastResetAt: "2026-11-20T20:17:42.000Z" });
    // A slow or failing lookup leaves lastResetAt empty rather than failing the check.
    const failing = await checkHealth(async () => {}, () => Promise.reject(new Error("relation does not exist")));
    expect(failing).toMatchObject({ ok: true, demoReset: { enabled: true, lastResetAt: null } });

    process.env.PAYPAL_ENVIRONMENT = "live";
    expect((await checkHealth(async () => {}, lastReset)).demoReset.refused).toMatch(/live PayPal/);
  });

  it("says whether the counter needs a code, and closes it when the code is too short", async () => {
    Object.assign(process.env, { DATABASE_URL: "memory", SHOP_ACCESS_CODE: "" });
    expect((await checkHealth(async () => {})).staffAccess).toEqual({ mode: "open", signInLocked: false });
    process.env.SHOP_ACCESS_CODE = "1234";
    expect((await checkHealth(async () => {})).staffAccess).toEqual({ mode: "misconfigured", signInLocked: false });
  });
});
