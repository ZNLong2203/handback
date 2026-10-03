import { describe, expect, it } from "vitest";
import { formatUsd, fromPayPalValue, parseUsdInput, toPayPalValue } from "./money";

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

  it("reads an amount staff typed, in dollars, and nothing else", () => {
    expect(parseUsdInput("12")).toBe(1200);
    expect(parseUsdInput("12.5")).toBe(1250);
    expect(parseUsdInput(" $12.50 ")).toBe(1250);
    expect(parseUsdInput("0.01")).toBe(1);
    for (const bad of ["", "-5", "12.505", "1e3", "12,50", "abc", "$", "12.", "99999999"]) expect(parseUsdInput(bad), bad).toBeNull();
  });
});
