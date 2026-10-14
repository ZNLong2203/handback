// The simple schedule (Bryntum did not load): the same view the timeline
// gets, laid out as rows per unit on the two weeks the timeline opens on.
import { describe, expect, it } from "vitest";
import { moneyLine, simpleSchedule } from "./simple";
import type { ScheduleEvent, ScheduleProposal, ScheduleResource, ScheduleView } from "./view";

const unit = (id: string, name: string, itemId: string, itemOrder: number, position: number, status: ScheduleResource["status"] = "shelf"): ScheduleResource => ({
  id,
  name,
  itemId,
  itemName: itemId === "projector" ? "Portable projector" : "Mirrorless camera kit",
  itemShort: name.replace(/\s+[A-Z]$/, ""),
  category: "",
  itemOrder,
  position,
  dailyCents: 2900,
  status,
  statusNote: null,
});

const booking = (id: string, resourceId: string, name: string, start: string, end: string, money: ScheduleEvent["money"] = "booked"): ScheduleEvent => ({
  id,
  resourceId,
  name,
  startDate: start,
  endDate: end,
  start,
  end,
  itemId: resourceId.replace(/-[a-z]$/, ""),
  itemName: "",
  unitLabel: "",
  money,
  statusLabel: "",
  feeCents: 8700,
  depositCents: 30000,
  heldCents: money === "held" ? 30000 : null,
  keptCents: money === "settled" ? 16000 : 0,
  releasedCents: 0,
  draggable: false,
  resizable: false,
  conflict: null,
  proposalId: null,
  cls: "",
});

const proposal = (p: Partial<ScheduleProposal>): ScheduleProposal => ({
  id: "P-1",
  kind: "reassign",
  origin: "agent",
  status: "pending",
  summary: "",
  message: null,
  messageSource: "template",
  needsCall: false,
  rentalId: null,
  customerName: null,
  customerEmail: null,
  itemName: null,
  fromUnit: null,
  toUnit: null,
  toUnitId: null,
  dates: null,
  newDates: null,
  targetStart: null,
  targetEnd: null,
  cause: null,
  command: null,
  createdAt: "",
  decidedAt: null,
  decisionNote: null,
  ...p,
});

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  today: "2026-10-14",
  window: { start: "2026-10-07", end: "2026-11-04" },
  resources: [unit("projector-b", "Projector B", "projector", 3, 2), unit("camera-kit-a", "Camera kit A", "camera-kit", 0, 1), unit("projector-a", "Projector A", "projector", 3, 1, "repair")],
  events: [],
  blocks: [],
  pending: [],
  decided: [],
  ai: false,
  demo: true,
  ...over,
});

describe("simpleSchedule", () => {
  it("shows the two weeks the timeline opens on, from two days before today", () => {
    const s = simpleSchedule(view());
    expect(s.days).toHaveLength(14);
    expect(s.days[0]).toBe("2026-10-12");
    expect(s.days[13]).toBe("2026-10-25");
    expect(s.days.indexOf(s.today)).toBe(2);
  });

  it("groups units by item in catalog order, units in shelf order", () => {
    const s = simpleSchedule(view());
    expect(s.groups.map((g) => [g.itemId, g.rows.map((r) => r.unit.id)])).toEqual([
      ["camera-kit", ["camera-kit-a"]],
      ["projector", ["projector-a", "projector-b"]],
    ]);
  });

  it("puts bookings on their days, both ends included, clipped to the two weeks", () => {
    const s = simpleSchedule(
      view({
        events: [
          booking("R-JORDAN", "projector-a", "Jordan Lee", "2026-10-11", "2026-10-14", "held"),
          booking("R-PRIYA", "projector-a", "Priya Patel", "2026-10-16", "2026-10-18"),
          booking("R-LONG", "camera-kit-a", "Ana Ruiz", "2026-10-20", "2026-10-30"),
          booking("R-PAST", "camera-kit-a", "Old Booking", "2026-10-01", "2026-10-05", "settled"),
        ],
      }),
    );
    const bars = Object.fromEntries(s.groups.flatMap((g) => g.rows.flatMap((r) => r.bars)).map((b) => [b.id, b]));
    expect(bars["R-JORDAN"]).toMatchObject({ from: 0, to: 2, clippedStart: true, clippedEnd: false, note: "$300 held", kind: "booking" });
    expect(bars["R-PRIYA"]).toMatchObject({ from: 4, to: 6, clippedStart: false, clippedEnd: false, note: "$300 at pickup", lane: 0 });
    expect(bars["R-LONG"]).toMatchObject({ from: 8, to: 13, clippedEnd: true });
    expect(bars["R-PAST"]).toBeUndefined();
  });

  it("draws repair blocks behind the bookings and the agent's suggestions on the unit they point at", () => {
    const s = simpleSchedule(
      view({
        events: [booking("R-PRIYA", "projector-a", "Priya Patel", "2026-10-16", "2026-10-18")],
        blocks: [
          {
            id: "B-1",
            resourceId: "projector-a",
            name: "In repair · Replace projector lens",
            startDate: "2026-10-14",
            endDate: "2026-10-20",
            start: "2026-10-14",
            end: "2026-10-19",
            kind: "repair",
            reason: "Replace projector lens",
            rentalId: "R-JORDAN",
            cls: "",
          },
        ],
        pending: [
          proposal({ id: "P-1", kind: "reassign", rentalId: "R-PRIYA", customerName: "Priya Patel", fromUnit: "Projector A", toUnitId: "projector-b", targetStart: "2026-10-16", targetEnd: "2026-10-18" }),
          proposal({ id: "P-2", kind: "reschedule", needsCall: true, rentalId: "R-DIEGO", customerName: "Diego Alvarez", toUnitId: "projector-b", targetStart: "2026-10-21", targetEnd: "2026-10-23" }),
          proposal({ id: "P-3", kind: "call", rentalId: "R-X", customerName: "X" }),
        ],
      }),
    );
    const rows = Object.fromEntries(s.groups.flatMap((g) => g.rows).map((r) => [r.unit.id, r]));
    expect(rows["projector-a"].bars.map((b) => [b.id, b.kind])).toEqual([
      ["B-1", "block"],
      ["R-PRIYA", "booking"],
    ]);
    expect(rows["projector-a"].lanes).toBe(1);
    expect(rows["projector-b"].bars).toMatchObject([
      { id: "ghost:P-1", kind: "suggestion", label: "Suggested: Priya Patel", note: "move here from Projector A", proposalId: "P-1", from: 4, to: 6 },
      { id: "ghost:P-2", kind: "suggestion", label: "Suggested: Diego Alvarez", note: "earliest free dates · call Diego first", needsCall: true },
    ]);
  });

  it("stacks bookings on the same days in lanes, so neither hides the other", () => {
    const s = simpleSchedule(
      view({
        events: [
          booking("R-1", "projector-b", "First", "2026-10-15", "2026-10-17"),
          booking("R-2", "projector-b", "Twin", "2026-10-16", "2026-10-18"),
          booking("R-3", "projector-b", "Later", "2026-10-18", "2026-10-19"),
        ],
      }),
    );
    const row = s.groups.flatMap((g) => g.rows).find((r) => r.unit.id === "projector-b")!;
    expect(row.bars.map((b) => [b.id, b.lane])).toEqual([
      ["R-1", 0],
      ["R-2", 1],
      ["R-3", 0],
    ]);
    expect(row.lanes).toBe(2);
  });
});

describe("moneyLine", () => {
  it("says the amount that matters at each stage, as the timeline does", () => {
    const at = (money: ScheduleEvent["money"], heldCents: number | null = null, keptCents = 0) => moneyLine({ money, depositCents: 30000, heldCents, keptCents });
    expect(at("booked")).toBe("$300 at pickup");
    expect(at("held", 30000)).toBe("$300 held");
    expect(at("review", 12550)).toBe("$125.50 held");
    expect(at("disputed")).toBe("dispute");
    expect(at("settled", null, 16000)).toBe("kept $160");
    expect(at("settled")).toBe("released");
  });
});
