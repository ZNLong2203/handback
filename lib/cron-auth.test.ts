import { describe, expect, it } from "vitest";
import { bearerMatches } from "./cron-auth";

describe("bearerMatches", () => {
  it("accepts only the exact bearer header", () => {
    expect(bearerMatches("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(bearerMatches("Bearer s3cret-valu", "s3cret-value")).toBe(false);
    expect(bearerMatches("s3cret-value", "s3cret-value")).toBe(false);
    expect(bearerMatches(null, "s3cret-value")).toBe(false);
    expect(bearerMatches("", "s3cret-value")).toBe(false);
  });
});
