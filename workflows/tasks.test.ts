// The Render Workflows tasks, run in-process the way Render runs them, against
// the demo stand-in, an in-memory database and recorded Gemini replies.
import type { TaskContext } from "@renderinc/sdk/workflows";
import { describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { inspectReturn, renewHolds } = await import("./tasks");

const ctx = (taskRunId: string): TaskContext => ({
  metadata: { taskRunId, rootTaskRunId: taskRunId },
  run: () => Promise.reject(new Error("these tasks do not chain runs")),
});

async function returnedRental(returnSample: string | null = "camera-kit/after__missing-hood") {
  const { rentalId, orderId } = await svc.startBooking({
    itemId: "camera-kit",
    name: "Maya Chen",
    email: "maya@example.com",
    startDate: todayIso(),
    endDate: addDaysIso(todayIso(), 3),
  });
  await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  await svc.holdDeposit(rentalId);
  if (returnSample) await svc.addPhoto(rentalId, "checkin", { sample: returnSample });
  return rentalId;
}

const assessments = async (rentalId: string) =>
  (await (await getDb()).query<{ id: string }>("select id from assessments where rental_id = $1", [rentalId])).length;

describe("inspect-return task", () => {
  it("compares once, records the run, and a retry returns the saved result", async () => {
    const rentalId = await returnedRental();
    const first = await inspectReturn.func(ctx("trn-first"), rentalId);
    expect(first.status).toBe("inspected");
    expect((await repo.rentalById(await getDb(), rentalId))?.status).toBe("inspecting");
    const completed = (await repo.eventsFor(await getDb(), rentalId)).find((e) => e.type === "inspection.completed");
    expect(completed?.data).toMatchObject({ worker: "render-workflows", taskRunId: "trn-first", source: "replay" });

    // Render retries a run whose attempt died after saving: the retry must not compare again.
    const retry = await inspectReturn.func(ctx("trn-first"), rentalId);
    expect(retry).toEqual({ status: "already-inspected", assessmentId: first.status === "inspected" ? first.assessmentId : "" });
    expect(await assessments(rentalId)).toBe(1);
  });

  it("lets two racing runs write one assessment", async () => {
    const rentalId = await returnedRental();
    const results = await Promise.all([inspectReturn.func(ctx("trn-a"), rentalId), inspectReturn.func(ctx("trn-b"), rentalId)]);
    expect(results.map((r) => r.status).sort()).toEqual(["already-inspected", "inspected"]);
    expect(await assessments(rentalId)).toBe(1);
  });

  it("refuses, without throwing, what a retry cannot fix", async () => {
    const rentalId = await returnedRental(null);
    expect(await inspectReturn.func(ctx("trn-early"), rentalId)).toEqual({
      status: "refused",
      message: "Both a pickup photo and a return photo are needed.",
    });
  });
});

describe("renew-holds task", () => {
  it("leaves demo-mode holds to the web process, where the stand-in's state lives", async () => {
    const result = await renewHolds.func(ctx("trn-renew"));
    expect(result).toMatchObject({ status: "skipped" });
  });
});
