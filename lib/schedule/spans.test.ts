import { describe, expect, it } from "vitest";
import { clashesOn, dayDiff, displaySpan, earliestSlot, firstFreeUnit, holdSpan, moveSpan, overlaps, type Occupant } from "./spans";

const rental = (over: Partial<Parameters<typeof holdSpan>[0]> = {}) => ({
  id: "R-1",
  status: "booked" as const,
  startDate: "2026-10-05",
  endDate: "2026-10-08",
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("spans", () => {
  it("counts both ends of a span, so a return day and a pickup day on the same unit clash", () => {
    expect(overlaps({ start: "2026-10-05", end: "2026-10-08" }, { start: "2026-10-08", end: "2026-10-10" })).toBe(true);
    expect(overlaps({ start: "2026-10-05", end: "2026-10-08" }, { start: "2026-10-09", end: "2026-10-10" })).toBe(false);
    expect(overlaps({ start: "2026-10-05", end: "2026-10-05" }, { start: "2026-10-01", end: "2026-10-31" })).toBe(true);
  });

  it("moves a span to a new start without changing its length, across a month end", () => {
    expect(dayDiff("2026-10-30", "2026-11-02")).toBe(3);
    expect(moveSpan({ start: "2026-10-05", end: "2026-10-08" }, "2026-10-30")).toEqual({ start: "2026-10-30", end: "2026-11-02" });
  });
});

describe("holdSpan: which rentals keep their unit", () => {
  const now = new Date("2026-10-02T12:00:00Z");

  it("holds the unit while booked or out", () => {
    expect(holdSpan(rental(), now)).toEqual({ start: "2026-10-05", end: "2026-10-08" });
    expect(holdSpan(rental({ status: "out" }), now)).toEqual({ start: "2026-10-05", end: "2026-10-08" });
  });

  it("holds it for an unpaid draft only while the customer is in PayPal", () => {
    expect(holdSpan(rental({ status: "draft", createdAt: "2026-10-02T11:45:00Z" }), now)).not.toBeNull();
    expect(holdSpan(rental({ status: "draft", createdAt: "2026-10-02T11:00:00Z" }), now)).toBeNull();
  });

  it("lets go once the item is back; a repair block takes over if it is damaged", () => {
    for (const status of ["inspecting", "customer_review", "responded", "settled", "disputed", "cancelled"] as const) {
      expect(holdSpan(rental({ status }), now)).toBeNull();
    }
  });
});

describe("displaySpan", () => {
  it("draws an early return up to the day it came back, and a booking as booked", () => {
    expect(displaySpan(rental({ status: "settled" }), "2026-10-06")).toEqual({ start: "2026-10-05", end: "2026-10-06" });
    expect(displaySpan(rental({ status: "settled" }), "2026-10-12")).toEqual({ start: "2026-10-05", end: "2026-10-08" });
    expect(displaySpan(rental({ status: "booked" }), null)).toEqual({ start: "2026-10-05", end: "2026-10-08" });
    expect(displaySpan(rental({ status: "draft" }), null)).toBeNull();
  });
});

describe("unit search", () => {
  const occupants: Occupant[] = [
    { kind: "block", id: "B-1", unitId: "a", span: { start: "2026-10-02", end: "2026-10-07" } },
    { kind: "rental", id: "R-2", unitId: "b", span: { start: "2026-10-07", end: "2026-10-10" } },
    { kind: "rental", id: "R-1", unitId: "a", span: { start: "2026-10-05", end: "2026-10-08" } },
  ];
  const r1 = { start: "2026-10-05", end: "2026-10-08" };

  it("ignores the rental being placed, but not anything else on the unit", () => {
    expect(clashesOn("a", r1, occupants, "R-1").map((o) => o.id)).toEqual(["B-1"]);
    expect(clashesOn("b", r1, occupants, "R-1").map((o) => o.id)).toEqual(["R-2"]);
  });

  it("never lets a rental clash with its own proposal", () => {
    const own: Occupant = { kind: "proposal", id: "P-1", rentalId: "R-1", unitId: "c", span: r1 };
    expect(clashesOn("c", r1, [...occupants, own], "R-1")).toEqual([]);
    expect(clashesOn("c", r1, [...occupants, own], "R-9")).toEqual([own]);
  });

  it("takes units in the order given", () => {
    expect(firstFreeUnit(["a", "b", "c"], r1, occupants, "R-1")).toBe("c");
    expect(firstFreeUnit(["c", "b"], { start: "2026-10-11", end: "2026-10-12" }, occupants)).toBe("c");
    expect(firstFreeUnit(["a", "b"], r1, occupants, "R-1")).toBeNull();
  });

  it("finds the earliest later start for the same length, day by day", () => {
    // a is blocked until the 7th and b is busy from the 7th to the 10th: a is free from the 8th.
    expect(earliestSlot(["a", "b"], r1, "2026-10-06", occupants, "R-1")).toEqual({ unitId: "a", span: { start: "2026-10-08", end: "2026-10-11" } });
    expect(earliestSlot(["b"], r1, "2026-10-06", occupants, "R-1")).toEqual({ unitId: "b", span: { start: "2026-10-11", end: "2026-10-14" } });
  });

  it("gives up after the horizon", () => {
    const longBlock: Occupant = { kind: "block", id: "B-2", unitId: "z", span: { start: "2026-10-01", end: "2026-12-31" } };
    expect(earliestSlot(["z"], r1, "2026-10-06", [longBlock], "R-1", 30)).toBeNull();
  });
});
