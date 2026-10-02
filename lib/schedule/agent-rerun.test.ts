// Running the schedule agent again must not churn: the schedule page runs it
// on every render and every live event re-renders the page, so a suggestion
// that is retired and made again on each run would loop for as long as a
// schedule tab is open. Demo mode, in-memory database.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("./repo");
const { runScheduleAgent } = await import("./agent");
const schedule = await import("./service");

const T = (n: number) => addDaysIso(todayIso(), n);
let n = 0;

/** A paid booking written straight to the table, on a given unit. */
async function booked(name: string, unitId: string, from: number, to: number): Promise<string> {
  const id = `R-RERUN${String(++n).padStart(3, "0")}`;
  await (
    await getDb()
  ).query(
    `insert into rentals (id, token, item_id, customer_name, customer_email, start_date, end_date, days, fee_cents, deposit_cents, status, unit_id)
     values ($1, $2, 'projector', $3, 'someone@example.com', $4, $5, $6, 1000, 1000, 'booked', $7)`,
    [id, `tok-${id}`, name, T(from), T(to), to - from, unitId],
  );
  return id;
}

const proposedEvents = async () =>
  (await (await getDb()).query<{ c: number }>("select count(*)::int as c from events where type = 'schedule.proposed'"))[0].c;

let yara = "";
let xavier = "";

beforeAll(async () => {
  // Projector A: Yara on days 10-12 and Xavier on 14-16, then full to day 110.
  yara = await booked("Yara Young", "projector-a", 10, 12);
  xavier = await booked("Xavier Cole", "projector-a", 14, 16);
  for (let d = 17; d <= 110; d += 10) await booked(`Filler A${d}`, "projector-a", d, Math.min(d + 9, 110));
  // Projector B: full apart from days 20-22.
  await booked("Filler B1", "projector-b", 1, 10);
  await booked("Filler B11", "projector-b", 11, 19);
  for (let d = 23; d <= 110; d += 10) await booked(`Filler B${d}`, "projector-b", d, Math.min(d + 9, 110));
  // Maintenance on Projector A over both Yara's and Xavier's days.
  await repo.insertBlock(await getDb(), {
    id: "B-RERUN1",
    unitId: "projector-a",
    startDate: T(10),
    endDate: T(16),
    kind: "maintenance",
    reason: "Bulb",
    rentalId: null,
    createdBy: "staff",
  });
});

describe("when the only free slot is set aside for another booking's fix", () => {
  it("offers the slot to the first booking and asks for a call for the second, once", async () => {
    const first = await runScheduleAgent();
    expect(first.superseded).toEqual([]);
    expect(first.proposals.map((p) => [p.rentalId, p.kind, p.toUnitId, p.startDate, p.endDate])).toEqual([
      [yara, "reschedule", "projector-b", T(20), T(22)],
      [xavier, "call", null, null, null],
    ]);
    expect(await proposedEvents()).toBe(2);
  });

  it("changes nothing on the next runs: the call is not retired for a slot that is already promised", async () => {
    for (let i = 0; i < 3; i++) expect(await runScheduleAgent()).toMatchObject({ superseded: [], proposals: [] });
    expect((await repo.listProposals(await getDb(), ["pending", "superseded"])).map((p) => [p.rentalId, p.kind, p.status])).toEqual([
      [yara, "reschedule", "pending"],
      [xavier, "call", "pending"],
    ]);
    expect(await proposedEvents()).toBe(2);
  });

  it("retires the call once the slot is free again, and offers it to the second booking", async () => {
    const [yaraFix] = (await repo.listProposals(await getDb(), "pending")).filter((p) => p.rentalId === yara);
    await schedule.rejectProposal(yaraFix.id, "Yara cancels instead");
    const run = await runScheduleAgent();
    expect(run.superseded).toHaveLength(1);
    expect(run.proposals.map((p) => [p.rentalId, p.kind, p.toUnitId, p.startDate, p.endDate])).toEqual([[xavier, "reschedule", "projector-b", T(20), T(22)]]);
    expect(await runScheduleAgent()).toMatchObject({ superseded: [], proposals: [] });
  });
});
