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
const { renewalRunKey } = await import("./config");
const { inspectReturnJob, renewHoldsJob } = await import("./jobs");
const { runInspection, runRenewals } = await import("./dispatch");

function fakeRender(opts: { failFirst?: boolean; unreachable?: boolean } = {}) {
  const runs = new Map<string, RunSnapshot>();
  const byKey = new Map<string, string>();
  const keys: string[] = [];
  let fail = opts.failFirst ?? false;
  const runner: TaskRunner = {
    async start(task, input, key) {
      if (opts.unreachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8120");
      keys.push(key);
      const existing = byKey.get(key);
      if (existing) return existing;
      const id = `trn-${runs.size + 1}`;
      byKey.set(key, id);
      if (fail) {
        fail = false;
        runs.set(id, { id, status: "failed", error: "Gemini answered 503 UNAVAILABLE", retries: 2 });
        return id;
      }
      const result = task === "inspect-return" ? await inspectReturnJob(String(input[0]), id) : await renewHoldsJob(clock);
      runs.set(id, { id, status: "completed", results: [result], retries: 0 });
      return id;
    },
    async get(id) {
      return runs.get(id)!;
    },
  };
  return { runner, keys };
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
    } finally {
      process.env = saved;
    }
  });
});
