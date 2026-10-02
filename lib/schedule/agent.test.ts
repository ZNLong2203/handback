// The schedule agent on the demo schedule: a damaged return blocks its unit,
// the affected bookings get a fix, and nothing moves until a person says so.
// Demo mode: PayPal stand-in, recorded Gemini replies, in-memory database.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const { firstBrokenLink } = await import("@/lib/rentals/audit");
const rentals = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { awaitingCustomer } = await import("@/lib/rentals/settlement");
const repo = await import("./repo");
const { runScheduleAgent, repairNeeded } = await import("./agent");
const schedule = await import("./service");
const { interpretCommand } = await import("./commands");
const { seedDemoSchedule, SEED_PLAN } = await import("./seed");
const { loadScheduleView } = await import("./view");
const { overlaps, holdSpan } = await import("./spans");

const T = (n: number) => addDaysIso(todayIso(), n);
const db = async () => getDb();

async function byName(name: string) {
  const rows = await (await db()).query<Record<string, unknown>>("select * from rentals where customer_name = $1 order by created_at desc limit 1", [name]);
  return rentals.toRental(rows[0]);
}
const pending = async () => repo.listProposals(await db(), "pending");
const types = async (rentalId: string) => (await rentals.eventsFor(await db(), rentalId)).map((e) => e.type);
const chainIntact = async (rentalId: string) => firstBrokenLink(await rentals.eventsFor(await db(), rentalId)) === null;

/** Every unit: no two rentals holding it on the same day, and none inside a block. */
async function assertNoDoubleBooking() {
  const d = await db();
  const rows = (await d.query<Record<string, unknown>>("select * from rentals where unit_id is not null")).map(rentals.toRental);
  const blocks = await repo.listBlocks(d, "2000-01-01", "2100-01-01");
  const holding = rows.flatMap((r) => {
    const span = holdSpan(r, new Date());
    return span ? [{ r, span }] : [];
  });
  for (const a of holding) {
    for (const b of holding) {
      if (a.r.id < b.r.id && a.r.unitId === b.r.unitId) expect(overlaps(a.span, b.span), `${a.r.customerName} and ${b.r.customerName}`).toBe(false);
    }
  }
  return { holding, blocks };
}

async function returnDamaged(name: string, sample: string) {
  const r = await byName(name);
  await svc.addPhoto(r.id, "checkin", { sample });
  await svc.inspect(r.id);
  const charges = awaitingCustomer((await rentals.latestAssessment(await db(), r.id))!.findings);
  await svc.sendToCustomer(r.id);
  await svc.respondAsCustomer(r.token, charges.map((f) => ({ findingId: f.id, answer: "accept" as const })));
  await svc.settle(r.id);
  return r;
}

beforeAll(async () => {
  await getDb();
});

describe("repairNeeded", () => {
  const finding = (kind: string, priceId: string, label: string, priceKind: "missing" | "damage" | "dirt", over = {}) =>
    ({
      id: priceId,
      kind,
      item: "",
      description: "",
      evidence: "",
      confidence: "high",
      boxBefore: null,
      boxAfter: null,
      price: { id: priceId, label, kind: priceKind, cents: 1000 },
      decision: "propose",
      reason: "",
      staff: "keep",
      customer: "accept",
      customerNote: null,
      resolution: null,
      ...over,
    }) as never;

  it("takes the longest charged repair, and ignores cleaning and waived findings", () => {
    expect(repairNeeded([finding("new_damage", "lens-crack", "Replace projector lens", "damage"), finding("missing", "missing-remote", "Replace remote control", "missing")])).toEqual({
      days: 6,
      reason: "Replace projector lens, Replace remote control",
      priceIds: ["lens-crack", "missing-remote"],
    });
    expect(repairNeeded([finding("dirt", "cleaning", "Cleaning beyond normal use", "dirt")])).toBeNull();
    expect(repairNeeded([finding("new_damage", "lens-crack", "Replace projector lens", "damage", { staff: "waive" })])).toBeNull();
    expect(repairNeeded([finding("new_damage", "lens-crack", "Replace projector lens", "damage", { customer: "contest", resolution: "waive" })])).toBeNull();
  });

  it("uses a sensible default for a price-list entry with no repair time", () => {
    expect(repairNeeded([finding("new_damage", "brand-new-part", "Something new", "damage")])?.days).toBe(3);
  });
});

describe("the schedule agent on two weeks of demo bookings", () => {
  it("seeds once: every booking on its planned unit, nothing double-booked, one repair already in", async () => {
    const ids = await seedDemoSchedule();
    expect(ids).toHaveLength(SEED_PLAN.length);
    for (const p of SEED_PLAN) {
      const r = await byName(p.name);
      expect(r.unitId, p.name).toBe(p.unit);
      expect([r.startDate, r.endDate], p.name).toEqual([T(p.from), T(p.to)]);
    }
    expect((await byName("Jordan Lee")).status).toBe("out");
    expect((await byName("Ravi Shah")).status).toBe("responded");
    expect((await byName("Ben Okafor")).status).toBe("settled");

    const { blocks } = await assertNoDoubleBooking();
    expect(blocks.map((b) => [b.unitId, b.kind, b.startDate, b.endDate, b.reason])).toEqual([["pa-speaker-a", "repair", T(0), T(2), "Replace speaker grille"]]);
    expect(await pending()).toHaveLength(0);

    expect(await seedDemoSchedule()).toEqual([]);
    const count = await (await db()).query("select id from rentals");
    expect(count).toHaveLength(SEED_PLAN.length);
  });

  it("a projector back with a cracked lens is blocked for the repair, and both bookings on it get a fix", async () => {
    const jordan = await returnDamaged("Jordan Lee", "projector/after__cracked-lens");
    const block = await repo.repairBlockFor(await db(), jordan.id);
    expect(block).toMatchObject({ unitId: "projector-a", kind: "repair", startDate: T(0), endDate: T(5), reason: "Replace projector lens", createdBy: "agent" });
    expect((await types(jordan.id)).slice(-2)).toEqual(["deposit.settled", "repair.blocked"]);
    expect(await chainIntact(jordan.id)).toBe(true);

    const [priya, diego] = await Promise.all([byName("Priya Patel"), byName("Diego Alvarez")]);
    const proposals = await pending();
    expect(proposals.map((p) => [p.rentalId, p.kind, p.fromUnitId, p.toUnitId, p.startDate, p.endDate, p.needsCall])).toEqual([
      // Projector B is free on Priya's dates: same dates, other unit.
      [priya.id, "reassign", "projector-a", "projector-b", null, null, false],
      // Projector B is busy on Diego's (Hannah), so the earliest dates on any unit, and a call first.
      [diego.id, "reschedule", "projector-a", "projector-a", T(6), T(8), true],
    ]);
    for (const p of proposals) {
      expect(p).toMatchObject({ origin: "agent", status: "pending", cause: `block:${block!.id}`, messageSource: "template" });
      expect(await types(p.rentalId!)).toContain("schedule.proposed");
    }
    expect(proposals[0].message).toMatch(/^Hi Priya, .*another one of the same model/);
    expect(proposals[1].message).toMatch(/^Hi Diego, .*earliest we can offer is/);

    // Running again changes nothing.
    expect(await runScheduleAgent()).toMatchObject({ blocks: [], proposals: [], superseded: [] });
  });

  it("holds the slot it set aside: a new customer cannot book it while the fix is pending", async () => {
    await expect(svc.startBooking({ itemId: "projector", name: "New Person", email: "new@example.com", startDate: T(2), endDate: T(4) })).rejects.toThrow(
      /Every Portable projector is booked/,
    );
  });

  it("approving moves the booking, after the same checks a drag gets", async () => {
    const [proposal] = await pending();
    const priya = await byName("Priya Patel");
    await schedule.approveProposal(proposal.id);
    expect((await byName("Priya Patel")).unitId).toBe("projector-b");
    expect(await repo.proposalById(await db(), proposal.id)).toMatchObject({ status: "approved" });
    const last = (await rentals.eventsFor(await db(), priya.id)).at(-1)!;
    expect(last).toMatchObject({ actor: "staff", type: "schedule.moved", data: { from: "projector-a", to: "projector-b", via: "agent", proposalId: proposal.id } });
    expect(await chainIntact(priya.id)).toBe(true);
    await expect(schedule.approveProposal(proposal.id)).rejects.toThrow(/already been decided/);
    expect((await pending()).map((p) => p.kind)).toEqual(["reschedule"]);
    await assertNoDoubleBooking();
  });

  it("a turned-down fix is not suggested again, and the clash stays on the timeline", async () => {
    const [diegoFix] = await pending();
    await schedule.rejectProposal(diegoFix.id, "Diego will collect from the other branch");
    expect(await runScheduleAgent()).toMatchObject({ proposals: [] });
    const view = await loadScheduleView();
    const diego = view.events.find((e) => e.name === "Diego Alvarez")!;
    expect(diego).toMatchObject({ resourceId: "projector-a", proposalId: null });
    expect(diego.conflict).toMatch(/Projector A is in repair/);
    expect(view.decided.find((p) => p.id === diegoFix.id)).toMatchObject({ status: "rejected", decisionNote: "Diego will collect from the other branch" });
  });

  it("a drag is checked on the server: same item, not picked up, no clash", async () => {
    const [maya, alex, hannah] = await Promise.all([byName("Maya Chen"), byName("Alex Kim"), byName("Hannah Wright")]);
    await expect(schedule.moveRentalToUnit(maya.id, "projector-a")).rejects.toThrow(/Projector A is not a Folding camera drone kit/);
    await expect(schedule.moveRentalToUnit(alex.id, "drone-kit-b")).rejects.toThrow(/only move before pickup/);
    await expect(schedule.moveRentalToUnit(hannah.id, "projector-a")).rejects.toThrow(/Projector A is booked by Diego Alvarez/);
    await expect(schedule.moveRentalToUnit(maya.id, "no-such-unit")).rejects.toThrow(/does not exist/);

    expect(await schedule.moveRentalToUnit(maya.id, "drone-kit-b")).toEqual({ moved: true });
    expect((await byName("Maya Chen")).unitId).toBe("drone-kit-b");
    expect((await rentals.eventsFor(await db(), maya.id)).at(-1)).toMatchObject({ type: "schedule.moved", data: { from: "drone-kit-a", to: "drone-kit-b", via: "drag" } });
    expect(await schedule.moveRentalToUnit(maya.id, "drone-kit-b")).toEqual({ moved: false });
    await assertNoDoubleBooking();
  });

  it("refuses to move a booking whose pickup day has passed", async () => {
    const maya = await byName("Maya Chen");
    const unit = (await repo.unitById(await db(), "drone-kit-a"))!;
    const yesterday = { ...maya, startDate: T(-1), endDate: T(2) };
    expect(schedule.moveProblem(yesterday, unit, { start: T(-1), end: T(2) }, todayIso())).toMatch(/has passed/);
    expect(schedule.moveProblem(maya, unit, { start: maya.startDate, end: addDaysIso(maya.endDate, 1) }, todayIso())).toMatch(/length/);
  });

  it("a typed command becomes one proposal, checked like a drag, and waits for a click", async () => {
    const maya = await byName("Maya Chen");
    const moved = await interpretCommand("move Maya's drone booking to the other unit", new Date(), null);
    expect(moved).toMatchObject({ ok: true, via: "parser" });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.proposal).toMatchObject({ kind: "reassign", origin: "command", rentalId: maya.id, fromUnitId: "drone-kit-b", toUnitId: "drone-kit-a", status: "pending" });
    expect((await byName("Maya Chen")).unitId).toBe("drone-kit-b");
    await schedule.approveProposal(moved.proposal.id);
    expect((await byName("Maya Chen")).unitId).toBe("drone-kit-a");

    expect(await interpretCommand("move Maya's drone booking to Projector B", new Date(), null)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Projector B is not a Folding camera drone kit/),
    });
    expect(await interpretCommand("what's the weather like", new Date(), null)).toMatchObject({ ok: false, message: expect.stringMatching(/I can move a booking/) });

    const blocked = await interpretCommand("block Projector B from tomorrow for 3 days for a sensor clean", new Date(), null);
    if (!blocked.ok) throw new Error(blocked.message);
    expect(blocked.proposal).toMatchObject({ kind: "block", toUnitId: "projector-b", startDate: T(1), endDate: T(3), blockKind: "maintenance", reason: "Sensor clean" });
    expect(blocked.proposal.summary).toMatch(/1 booking clashes \(Priya Patel\)/);
    await schedule.approveProposal(blocked.proposal.id);
    // Priya is on Projector B now, which is blocked; Projector A is in repair: the agent looks for dates.
    const priya = await byName("Priya Patel");
    const fix = (await pending()).find((p) => p.rentalId === priya.id)!;
    expect(fix).toMatchObject({ kind: "reschedule", needsCall: true, cause: expect.stringMatching(/^block:/) });
    await assertNoDoubleBooking();
  });

  it("takes Gemini's tool call only when it fits the schema, and still checks it", async () => {
    const maya = await byName("Maya Chen");
    const ok = await interpretCommand("put Maya on the other drone", new Date(), async () => ({
      name: "reassign_booking",
      args: { booking_id: maya.id, to_unit_id: "drone-kit-b" },
    }));
    expect(ok).toMatchObject({ ok: true, via: "gemini", proposal: { toUnitId: "drone-kit-b", command: "put Maya on the other drone" } });
    expect(await interpretCommand("block it", new Date(), async () => ({ name: "block_unit", args: { unit_id: "projector-a" } }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/did not fit/),
    });
    expect(await interpretCommand("move the thing", new Date(), async () => ({ name: "ask_staff", args: { question: "Which booking do you mean?" } }))).toMatchObject({
      ok: false,
      message: "Which booking do you mean?",
    });
    expect(
      await interpretCommand("move it", new Date(), async () => ({ name: "reassign_booking", args: { booking_id: "R-NOTREAL", to_unit_id: "drone-kit-b" } })),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/does not match a booking/) });
  });
});
