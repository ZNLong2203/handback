// POST /api/jobs/renew-holds as the Render cron job calls it, with sandbox
// PayPal settings and Render Workflows replaced by a runner whose runs are
// scripted. The PayPal stand-in takes PayPal's place for renewals made here.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "@/lib/workflows/config";
import type { TaskRunner } from "@/lib/workflows/runner";

const render = vi.hoisted(() => ({ next: null as RunSnapshot | null, started: [] as unknown[][] }));

vi.mock("@/lib/workflows/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows/runner")>();
  const runner: TaskRunner = {
    async start(_task, input) {
      render.started.push(input);
      return "trn-cron";
    },
    async get() {
      return render.next!;
    },
  };
  return { ...actual, renderRunner: () => runner };
});

const saved = { ...process.env };
Object.assign(process.env, {
  DATABASE_URL: "memory",
  DEMO_MODE: "false",
  PAYPAL_CLIENT_ID: "sandbox-client",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
  CRON_SECRET: "cron-test-secret",
});
afterAll(() => {
  process.env = saved;
});

const { DemoDepositGateway } = await import("@/lib/paypal/demo-gateway");
(globalThis as { depositGateway?: unknown }).depositGateway = new DemoDepositGateway();
const { POST } = await import("./route");

const call = (authorization = "Bearer cron-test-secret") =>
  POST(new Request("http://localhost/api/jobs/renew-holds", { method: "POST", headers: { authorization } }));

beforeEach(() => {
  render.started = [];
});

describe("POST /api/jobs/renew-holds", () => {
  it("refuses a caller without the cron secret", async () => {
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(render.started).toEqual([]);
  });

  it("starts the sweep with this service's modes and counts the outcomes", async () => {
    render.next = {
      id: "trn-cron",
      status: "completed",
      results: [
        {
          status: "swept",
          results: [
            { rentalId: "R-1", outcome: "renewed", detail: "AUTH-2" },
            { rentalId: "R-2", outcome: "failed", detail: "AUTHORIZATION_VOIDED" },
            { rentalId: "R-3", outcome: "not-due" },
          ],
        },
      ],
    };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ranOn: "render-workflows", taskRunId: "trn-cron", pending: false, warning: null, renewed: 1, failed: 1 });
    expect(render.started).toEqual([[{ paypal: "sandbox", ai: "recorded-replies" }]]);
  });

  it("sweeps here and returns a warning when the task skipped the sweep", async () => {
    const reason = 'The web service runs in PayPal mode "sandbox", but the workflow service runs in "demo".';
    render.next = { id: "trn-cron", status: "completed", results: [{ status: "skipped", reason }] };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ranOn: "web",
      taskRunId: "trn-cron",
      warning: `Render Workflows run trn-cron skipped the sweep: ${reason}`,
      failed: 0,
    });
  });

  it("answers 502 when the run failed on Render", async () => {
    render.next = { id: "trn-cron", status: "failed", error: "database unreachable", retries: 2 };
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Render Workflows run trn-cron failed after 3 attempt(s): database unreachable" });
  });

  describe("with a sweep that outlasts the wait", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("answers with the run id and pending: true", async () => {
      render.next = { id: "trn-cron", status: "running" };
      const answer = call();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const res = await answer;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, ranOn: "render-workflows", taskRunId: "trn-cron", pending: true, results: [] });
    });
  });
});
