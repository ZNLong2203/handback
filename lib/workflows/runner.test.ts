// Polling a Render task run, and the wiring to the official SDK, with Render
// replaced by scripted answers and the clock moved by the pause function.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "./config";
import { renderRunner, waitForRun, type TaskRunner } from "./runner";

const sdk = vi.hoisted(() => ({
  made: 0,
  startTask: vi.fn<(task: string, input: unknown[], opts: { idempotencyKey: string }) => Promise<{ taskRunId: string }>>(async () => ({
    taskRunId: "trn-started",
  })),
  getTaskRun: vi.fn(async (id: string) => ({ id, status: "running" })),
}));

vi.mock("@renderinc/sdk", () => ({
  Render: class {
    workflows = { startTask: sdk.startTask, getTaskRun: sdk.getTaskRun };
    constructor() {
      sdk.made++;
    }
  },
}));

/** Answers get() from the script in order, repeating the last entry; an Error entry is thrown. */
function scripted(...answers: (RunSnapshot | Error)[]) {
  let reads = 0;
  const runner: TaskRunner = {
    start: () => Promise.reject(new Error("not used")),
    async get() {
      const answer = answers[Math.min(reads++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { runner, reads: () => reads };
}

const run = (status: string, extra: Partial<RunSnapshot> = {}): RunSnapshot => ({ id: "trn-1", status, ...extra });
const readError = (n: number) => new Error(`read ${n} failed`);

describe("waitForRun", () => {
  let pauses: number[];
  const pause = async (ms: number) => {
    pauses.push(ms);
    vi.setSystemTime(Date.now() + ms);
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-20T09:17:00Z") });
    pauses = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until the run finishes, backing off between reads", async () => {
    const render = scripted(run("pending"), run("running"), run("completed", { results: [{ status: "inspected" }] }));
    expect(await waitForRun(render.runner, "trn-1", 60_000, pause)).toEqual({ kind: "done", taskRunId: "trn-1", result: { status: "inspected" } });
    expect(pauses).toEqual([500, 750]);
  });

  it("reports a run that failed after Render's retries", async () => {
    const render = scripted(run("failed", { error: "Gemini answered 503", retries: 2 }));
    expect(await waitForRun(render.runner, "trn-1", 60_000, pause)).toEqual({ kind: "failed", taskRunId: "trn-1", error: "Gemini answered 503", attempts: 3 });
    expect(pauses).toEqual([]);
  });

  it("gives up waiting at the deadline and says the run is still going", async () => {
    const render = scripted(run("running"));
    expect(await waitForRun(render.runner, "trn-1", 10_000, pause)).toEqual({ kind: "running", taskRunId: "trn-1" });
    expect(pauses).toEqual([500, 750, 1125, 1688, 2532, 3000]);
    expect(pauses.reduce((a, b) => a + b)).toBeLessThanOrEqual(10_000);
    expect(render.reads()).toBe(pauses.length + 1);
  });

  it("tolerates four failed reads in a row", async () => {
    const render = scripted(readError(1), readError(2), readError(3), readError(4), run("completed", { results: [7] }));
    expect(await waitForRun(render.runner, "trn-1", 60_000, pause)).toMatchObject({ kind: "done", result: 7 });
  });

  it("throws the fifth failed read in a row", async () => {
    const render = scripted(readError(1), readError(2), readError(3), readError(4), readError(5), run("completed"));
    await expect(waitForRun(render.runner, "trn-1", 60_000, pause)).rejects.toThrow("read 5 failed");
    expect(render.reads()).toBe(5);
  });

  it("starts counting failed reads again after a good one", async () => {
    const render = scripted(
      ...[1, 2, 3, 4].map(readError),
      run("running"),
      ...[5, 6, 7, 8].map(readError),
      run("completed", { results: ["ok"] }),
    );
    expect(await waitForRun(render.runner, "trn-1", 60_000, pause)).toMatchObject({ kind: "done", result: "ok" });
  });
});

describe("renderRunner", () => {
  beforeEach(() => {
    sdk.made = 0;
    sdk.startTask.mockClear();
    sdk.getTaskRun.mockClear();
  });

  it("is null when jobs run in the web process", () => {
    expect(renderRunner({ runner: "inline", reason: "RENDER_API_KEY is not set" })).toBeNull();
  });

  it("starts runs as <workflow slug>/<task> with the idempotency key, through one SDK client", async () => {
    const runner = renderRunner({ runner: "render", slug: "handback-workflows", local: false })!;
    expect(sdk.made).toBe(0);
    const modes = { paypal: "sandbox", ai: "gemini" };
    expect(await runner.start("inspect-return", ["R-7KQ2MX", modes], "inspect-R-7KQ2MX-0")).toBe("trn-started");
    expect(sdk.startTask).toHaveBeenCalledWith("handback-workflows/inspect-return", ["R-7KQ2MX", modes], { idempotencyKey: "inspect-R-7KQ2MX-0" });
    expect(await runner.get("trn-started")).toEqual({ id: "trn-started", status: "running" });
    expect(sdk.getTaskRun).toHaveBeenCalledWith("trn-started");
    expect(sdk.made).toBe(1);
  });

  it("uses the bare task name with the local task server", async () => {
    await renderRunner({ runner: "render", slug: null, local: true })!.start("renew-holds", [], "renew-holds-2026-11-20T09");
    expect(sdk.startTask).toHaveBeenCalledWith("renew-holds", [], { idempotencyKey: "renew-holds-2026-11-20T09" });
  });
});
