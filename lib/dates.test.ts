import { describe, expect, it } from "vitest";
import { isIsoDay, rentalDays } from "./dates";

describe("dates", () => {
  it("accepts only real calendar days", () => {
    expect(isIsoDay("2026-10-03")).toBe(true);
    expect(isIsoDay("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", "2026-1-5", "this weekend"]) expect(isIsoDay(bad)).toBe(false);
  });

  it("counts rental days, a same-day rental as one, and refuses impossible dates", () => {
    expect(rentalDays("2026-10-03", "2026-10-05")).toBe(2);
    expect(rentalDays("2026-10-03", "2026-10-03")).toBe(1);
    expect(() => rentalDays("2026-02-27", "2026-02-31")).toThrow(RangeError);
    expect(() => rentalDays("2026-10-05", "2026-10-03")).toThrow(RangeError);
  });
});
