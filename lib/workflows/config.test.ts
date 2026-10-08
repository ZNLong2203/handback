import { describe, expect, it } from "vitest";
import { databaseMissing, inspectionRunKey, lastSkippedRun, modeMismatch, noteSkippedRun, renewalRunKey, runOutcome, taskIdentifier, workflowsConfig } from "./config";

describe("workflowsConfig", () => {
  it("runs inline until the Blueprint slug and an API key are both there", () => {
    expect(workflowsConfig({})).toEqual({ runner: "inline", reason: "RENDER_WORKFLOW_SLUG is not set" });
    expect(workflowsConfig({ RENDER_WORKFLOW_SLUG: "handback-workflows" })).toEqual({ runner: "inline", reason: "RENDER_API_KEY is not set" });
    expect(workflowsConfig({ RENDER_WORKFLOW_SLUG: " handback-workflows ", RENDER_API_KEY: "rnd_test" })).toEqual({
      runner: "render",
      slug: "handback-workflows",
      local: false,
    });
  });

  it("uses the local task server without a key, and the off switch wins over everything", () => {
    expect(workflowsConfig({ RENDER_USE_LOCAL_DEV: "true" })).toEqual({ runner: "render", slug: null, local: true });
    expect(workflowsConfig({ RENDER_LOCAL_DEV_URL: "http://localhost:8121" })).toEqual({ runner: "render", slug: null, local: true });
    expect(workflowsConfig({ RENDER_USE_LOCAL_DEV: "no" }).runner).toBe("inline");
    expect(
      workflowsConfig({ RENDER_WORKFLOWS: "off", RENDER_WORKFLOW_SLUG: "handback-workflows", RENDER_API_KEY: "rnd_test" }),
    ).toEqual({ runner: "inline", reason: "RENDER_WORKFLOWS is off" });
  });
});

describe("task identifiers and keys", () => {
  it("prefixes the workflow slug when there is one", () => {
    expect(taskIdentifier("handback-workflows", "inspect-return")).toBe("handback-workflows/inspect-return");
    expect(taskIdentifier(null, "renew-holds")).toBe("renew-holds");
  });

  it("derives the inspection key from the rental and its failed runs", () => {
    expect(inspectionRunKey("R-7KQ2MX", 0)).toBe("inspect-R-7KQ2MX-0");
    expect(inspectionRunKey("R-7KQ2MX", 1)).toBe("inspect-R-7KQ2MX-1");
  });

  it("keys the renewal sweep by UTC hour", () => {
    expect(renewalRunKey(new Date("2026-11-20T09:05:00Z"))).toBe("renew-holds-2026-11-20T09");
    expect(renewalRunKey(new Date("2026-11-20T09:59:59Z"))).toBe(renewalRunKey(new Date("2026-11-20T09:00:00Z")));
    expect(renewalRunKey(new Date("2026-11-20T10:00:00Z"))).not.toBe(renewalRunKey(new Date("2026-11-20T09:00:00Z")));
  });
});

describe("runOutcome", () => {
  it("unwraps the return value of a finished run", () => {
    expect(runOutcome({ id: "trn-1", status: "completed", results: [{ status: "inspected" }] })).toEqual({
      kind: "done",
      taskRunId: "trn-1",
      result: { status: "inspected" },
    });
    expect(runOutcome({ id: "trn-1", status: "succeeded", results: [7] })).toMatchObject({ kind: "done", result: 7 });
  });

  it("reports failures with the attempt count, and anything else as still running", () => {
    expect(runOutcome({ id: "trn-2", status: "failed", error: "vision model reply failed validation twice", retries: 2 })).toEqual({
      kind: "failed",
      taskRunId: "trn-2",
      error: "vision model reply failed validation twice",
      attempts: 3,
    });
    expect(runOutcome({ id: "trn-3", status: "canceled" })).toMatchObject({ kind: "failed", error: "The run was canceled.", attempts: 1 });
    for (const status of ["pending", "running", "paused"]) expect(runOutcome({ id: "trn-4", status }).kind).toBe("running");
  });
});

describe("modeMismatch", () => {
  const worker = { paypal: "demo", ai: "recorded-replies" } as const;

  it("names the setting to fix when the web service's mode differs", () => {
    expect(modeMismatch({ paypal: "sandbox", ai: "gemini" }, worker, "paypal")).toBe(
      'The web service runs in PayPal mode "sandbox", but the workflow service runs in "demo". Give the workflow service the same PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENVIRONMENT as the web service.',
    );
    expect(modeMismatch({ paypal: "sandbox", ai: "gemini" }, worker, "ai")).toMatch(/AI mode "gemini", but the workflow service runs in "recorded-replies"\. .*GEMINI_API_KEY/);
  });

  it("checks only the mode the task depends on", () => {
    expect(modeMismatch({ paypal: "sandbox", ai: "recorded-replies" }, worker, "ai")).toBeNull();
    expect(modeMismatch({ paypal: "demo", ai: "gemini" }, worker, "paypal")).toBeNull();
  });

  it("lets a run without modes through, as when it is started from the dashboard", () => {
    for (const web of [undefined, null, "sandbox", [], {}, { paypal: 1 }]) expect(modeMismatch(web, worker, "paypal")).toBeNull();
  });
});

describe("skipped runs", () => {
  it("keeps the latest one for /api/health", () => {
    noteSkippedRun({ task: "renew-holds", taskRunId: "trn-1", reason: "first" }, new Date("2026-11-20T09:17:00Z"));
    noteSkippedRun({ task: "inspect-return", taskRunId: "trn-2", reason: "second" }, new Date("2026-11-20T10:02:00Z"));
    expect(lastSkippedRun()).toEqual({ task: "inspect-return", taskRunId: "trn-2", reason: "second", at: "2026-11-20T10:02:00.000Z" });
  });
});

describe("databaseMissing", () => {
  it("stops a Render task run that has no DATABASE_URL, and nothing else", () => {
    expect(databaseMissing({ RENDER_SDK_SOCKET_PATH: "/tmp/sdk.sock" })).toMatch(/no DATABASE_URL/);
    expect(databaseMissing({ RENDER_SDK_SOCKET_PATH: "/tmp/sdk.sock", DATABASE_URL: "  " })).toMatch(/no DATABASE_URL/);
    expect(databaseMissing({ RENDER_SDK_SOCKET_PATH: "/tmp/sdk.sock", DATABASE_URL: "postgres://db/handback" })).toBeNull();
    expect(databaseMissing({})).toBeNull();
  });
});
