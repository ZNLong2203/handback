import { describe, expect, it } from "vitest";
import { inspectionRunKey, renewalRunKey, runOutcome, taskIdentifier, workflowsConfig } from "./config";

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
