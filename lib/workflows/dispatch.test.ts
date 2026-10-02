// The web side of Render Workflows, with a stand-in for Render that runs the
// task bodies in-process and honours idempotency keys the way the API does:
// the same key hands back the run it started the first time.
import { describe, expect, it } from "vitest";
import type { RunSnapshot } from "./config";
import type { TaskRunner } from "./runner";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
let clock = new Date();
const gateway = new DemoDepositGateway(() => clock);
(globalThis as { depositGateway?: unknown }).depositGateway = gateway;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { lastSkippedRun, renewalRunKey } = await import("./config");
const { inspectReturnJob, renewHoldsJob } = await import("./jobs");
const { runInspection, runRenewals } = await import("./dispatch");

/** `workerEnv` is the workflow service's own settings, applied while a task body runs. */
function fakeRender(opts: { failFirst?: boolean; unreachable?: boolean; workerEnv?: Record<string, string> } = {}) {
  const runs = new Map<string, RunSnapshot>();
  const byKey = new Map<string, string>();
  const keys: string[] = [];
  const inputs: unknown[][] = [];
  let fail = opts.failFirst ?? false;
  const asWorker = async <T,>(body: () => Promise<T>): Promise<T> => {
    const saved = { ...process.env };
    Object.assign(process.env, opts.workerEnv);
    try {
      return await body();
    } finally {
      process.env = saved;
    }
  };
  const runner: TaskRunner = {
    async start(task, input, key) {
      if (opts.unreachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8120");
      keys.push(key);
      const existing = byKey.get(key);
      if (existing) return existing;
      inputs.push(input);
      const id = `trn-${runs.size + 1}`;
      byKey.set(key, id);
      if (fail) {
        fail = false;
        runs.set(id, { id, status: "failed", error: "Gemini answered 503 UNAVAILABLE", retries: 2 });
        return id;
      }
      const result = await asWorker<unknown>(() =>
        task === "inspect-return" ? inspectReturnJob(String(input[0]), id, input[1]) : renewHoldsJob(clock, input[0]),
      );
      runs.set(id, { id, status: "completed", results: [result], retries: 0 });
      return id;
    },
    async get(id) {
      return runs.get(id)!;
    },
  };
  return { runner, keys, inputs };
}

async function heldRental(days = 3, returnSample: string | null = "camera-kit/after__missing-hood") {
  const { rentalId, orderId } = await svc.startBooking({
    itemId: "camera-kit",
    name: "Maya Chen",
    email: "maya@example.com",
    startDate: todayIso(clock),
    endDate: addDaysIso(todayIso(clock), days),
  });
  await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(rentalId);
  if (returnSample) await svc.addPhoto(rentalId, "checkin", { sample: returnSample });
  return rentalId;
}

const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;
const events = async (id: string) => repo.eventsFor(await getDb(), id);

describe("runInspection", () => {
  it("compares on Render Workflows, and a second press joins the same run", async () => {
    const id = await heldRental();
    const render = fakeRender();
    await runInspection(id, render.runner);
    expect((await rental(id)).status).toBe("inspecting");
    expect((await events(id)).find((e) => e.type === "inspection.completed")?.data.taskRunId).toBe("trn-1");
    expect(render.inputs).toEqual([[id, { paypal: "demo", ai: "recorded-replies" }]]);

    await runInspection(id, render.runner);
    expect(render.keys).toEqual([`inspect-${id}-0`, `inspect-${id}-0`]);
    expect((await events(id)).filter((e) => e.type === "inspection.completed")).toHaveLength(1);
  });

  it("records a failed run once, and the next press starts a fresh one", async () => {
    const id = await heldRental();
    const render = fakeRender({ failFirst: true });
    await expect(runInspection(id, render.runner)).rejects.toThrow(/failed after 3 attempts on Render Workflows \(run trn-1\)/);
    expect((await rental(id)).status).toBe("out");
    const failed = (await events(id)).filter((e) => e.type === "inspection.failed");
    expect(failed.map((e) => e.data)).toEqual([
      { worker: "render-workflows", taskRunId: "trn-1", attempts: 3, error: "Gemini answered 503 UNAVAILABLE" },
    ]);

    await runInspection(id, render.runner);
    expect(render.keys).toEqual([`inspect-${id}-0`, `inspect-${id}-1`]);
    expect((await rental(id)).status).toBe("inspecting");
  });

  it("compares in the web process when Render cannot be reached", async () => {
    const id = await heldRental();
    await runInspection(id, fakeRender({ unreachable: true }).runner);
    expect((await rental(id)).status).toBe("inspecting");
    expect((await events(id)).find((e) => e.type === "inspection.completed")?.data).not.toHaveProperty("taskRunId");
  });

  it("compares in the web process when the workflow runs in another AI mode", async () => {
    const id = await heldRental();
    // The workflow has a Gemini key this web service lacks; it must not answer for it.
    const render = fakeRender({ workerEnv: { DEMO_MODE: "false", GEMINI_API_KEY: "worker-only-key" } });
    await runInspection(id, render.runner);
    expect((await rental(id)).status).toBe("inspecting");
    const completed = (await events(id)).find((e) => e.type === "inspection.completed")!;
    expect(completed.data).toMatchObject({ source: "replay" });
    expect(completed.data).not.toHaveProperty("worker");
    expect(lastSkippedRun()).toMatchObject({ task: "inspect-return", taskRunId: "trn-1", reason: expect.stringContaining("GEMINI_API_KEY") });
  });

  it("shows staff why a task refused to compare", async () => {
    const id = await heldRental(3, null);
    await expect(runInspection(id, fakeRender().runner)).rejects.toThrow("Both a pickup photo and a return photo are needed.");
  });
});

describe("runRenewals", () => {
  it("renews demo holds in the web process, without asking Render", async () => {
    const render = fakeRender();
    expect(await runRenewals(clock, render.runner)).toMatchObject({ ranOn: "web" });
    expect(render.keys).toEqual([]);
  });

  it("runs the sweep as a task once PayPal is real, keyed by the hour", async () => {
    clock = new Date();
    const id = await heldRental(14, null);
    clock = new Date(clock.getTime() + 13 * 86_400_000);
    const saved = { ...process.env };
    Object.assign(process.env, { DEMO_MODE: "false", PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret" });
    try {
      const render = fakeRender();
      const run = await runRenewals(clock, render.runner);
      expect(run).toMatchObject({ ranOn: "render-workflows", taskRunId: "trn-1" });
      expect(run.results.find((r) => r.rentalId === id)?.outcome).toBe("renewed");
      expect(render.keys).toEqual([renewalRunKey(clock)]);
      expect(render.inputs).toEqual([[{ paypal: "sandbox", ai: "recorded-replies" }]]);
    } finally {
      process.env = saved;
    }
  });

  it("renews here, with a warning, when the workflow has no PayPal keys", async () => {
    clock = new Date(clock.getTime() + 86_400_000);
    const id = await heldRental(14, null);
    clock = new Date(clock.getTime() + 13 * 86_400_000);
    const saved = { ...process.env };
    Object.assign(process.env, { DEMO_MODE: "false", PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret" });
    try {
      const run = await runRenewals(clock, fakeRender({ workerEnv: { PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" } }).runner);
      expect(run).toMatchObject({ ranOn: "web", taskRunId: "trn-1", warning: expect.stringMatching(/^Render Workflows run trn-1 skipped the sweep: .*"demo"/) });
      expect(run.results.find((r) => r.rentalId === id)?.outcome).toBe("renewed");
      expect(lastSkippedRun()).toMatchObject({ task: "renew-holds", taskRunId: "trn-1" });
    } finally {
      process.env = saved;
    }
  });
});
