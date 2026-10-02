import { describe, expect, it } from "vitest";
import { formatUsd, fromPayPalValue, toPayPalValue } from "./money";

describe("money", () => {
  it("converts cents to PayPal decimal strings and back", () => {
    expect(toPayPalValue(38000)).toBe("380.00");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(fromPayPalValue("125.00")).toBe(12500);
    expect(fromPayPalValue("0.5")).toBe(50);
    expect(fromPayPalValue("12")).toBe(1200);
  });

  it("rejects fractional cents and malformed amounts", () => {
    expect(() => toPayPalValue(10.5)).toThrow(RangeError);
    expect(() => toPayPalValue(-1)).toThrow(RangeError);
    expect(() => fromPayPalValue("1.234")).toThrow(RangeError);
    expect(() => fromPayPalValue("abc")).toThrow(RangeError);
  });

  it("formats for people", () => {
    expect(formatUsd(25500)).toBe("$255.00");
    expect(formatUsd(123456)).toBe("$1,234.56");
  });
});
