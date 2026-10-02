import { afterEach, describe, expect, it } from "vitest";
import { checkHealth } from "./health";

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
      jobs: { runner: "render-workflows", slug: "handback-workflows" },
      build: { commit: "0123456789abcdef0123456789abcdef01234567", branch: "main" },
    });
    const body = JSON.stringify(health);
    for (const value of Object.values(SECRETS)) expect(body).not.toContain(value);
    expect(body).not.toContain("db-password-value");
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
});
