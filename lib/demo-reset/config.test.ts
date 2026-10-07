// When the nightly demo reset runs, and how the pages say so. The cron job
// and the web service share parseResetHour, resetDueAt and resetDayOf.
import { describe, expect, it } from "vitest";
import { parseResetHour, resetDueAt } from "@/scripts/cron/demo-reset-hour.mjs";
import { demoResetConfig, nextResetAt, resetDayOf, resetReseeds, resetSeedWallet, resetTimeLabel } from "./config";

describe("the reset hour", () => {
  it("is DEMO_RESET_HOUR from 0 to 23, and 20 UTC when unset or unusable", () => {
    expect(parseResetHour(undefined)).toEqual({ hour: 20, valid: true });
    expect(parseResetHour("")).toEqual({ hour: 20, valid: true });
    expect(parseResetHour(" 3 ")).toEqual({ hour: 3, valid: true });
    expect(parseResetHour("0")).toEqual({ hour: 0, valid: true });
    expect(parseResetHour("23")).toEqual({ hour: 23, valid: true });
    for (const bad of ["24", "-1", "3.5", "8pm", "1e1"]) expect(parseResetHour(bad), bad).toEqual({ hour: 20, valid: false });
  });

  it("is due on the hourly run that falls in that hour, in UTC", () => {
    expect(resetDueAt(new Date("2026-11-20T20:17:00Z"), 20)).toBe(true);
    expect(resetDueAt(new Date("2026-11-20T19:17:00Z"), 20)).toBe(false);
    expect(resetDueAt(new Date("2026-11-20T21:17:00Z"), 20)).toBe(false);
    // 3:17 in Vietnam (UTC+7) is 20:17 UTC the day before.
    expect(resetDueAt(new Date("2026-11-21T03:17:00+07:00"), 20)).toBe(true);
  });

  it("counts a reset day from the reset hour", () => {
    expect(resetDayOf(new Date("2026-11-20T20:00:00Z"), 20)).toBe("2026-11-20");
    expect(resetDayOf(new Date("2026-11-21T19:59:59Z"), 20)).toBe("2026-11-20");
    expect(resetDayOf(new Date("2026-11-21T20:00:00Z"), 20)).toBe("2026-11-21");
    expect(resetDayOf(new Date("2026-11-21T00:30:00Z"), 0)).toBe("2026-11-21");
  });
});

describe("demoResetConfig", () => {
  it("is off unless DEMO_RESET is exactly true, and refuses live PayPal", () => {
    expect(demoResetConfig({})).toEqual({ enabled: false, hourUtc: 20, refusal: null });
    expect(demoResetConfig({ DEMO_RESET: "yes", DEMO_RESET_HOUR: "4" })).toEqual({ enabled: false, hourUtc: 4, refusal: null });
    expect(demoResetConfig({ DEMO_RESET: "true", PAYPAL_ENVIRONMENT: "sandbox" })).toMatchObject({ enabled: true, refusal: null });
    expect(demoResetConfig({ DEMO_RESET: "true", PAYPAL_ENVIRONMENT: "live" }).refusal).toMatch(/never runs against live PayPal/);
  });

  it("seeds the sandbox only with an explicit saved wallet, never the newest one", () => {
    expect(resetSeedWallet("sandbox", { SEED_VAULT_ID: " 8kd1234 " })).toBe("8kd1234");
    expect(resetSeedWallet("sandbox", { SEED_VAULT_ID: "latest" })).toBeUndefined();
    expect(resetSeedWallet("sandbox", {})).toBeUndefined();
    expect(resetSeedWallet("demo", { SEED_VAULT_ID: "8kd1234" })).toBeUndefined();
    expect(resetReseeds("demo", {})).toBe(true);
    expect(resetReseeds("sandbox", {})).toBe(false);
    expect(resetReseeds("sandbox", { SEED_VAULT_ID: "8kd1234" })).toBe(true);
  });
});

describe("resetTimeLabel", () => {
  it("gives the next reset in UTC, in California time and from now", () => {
    expect(nextResetAt(new Date("2026-10-07T08:00:00Z"), 20).toISOString()).toBe("2026-10-07T20:00:00.000Z");
    expect(nextResetAt(new Date("2026-10-07T20:30:00Z"), 20).toISOString()).toBe("2026-10-08T20:00:00.000Z");
    // Daylight saving time ends in California on Nov 1, 2026.
    expect(resetTimeLabel(20, new Date("2026-10-07T08:00:00Z"))).toEqual({ utc: "20:00 UTC", pacific: "1 PM Pacific", until: "next in about 12 hours" });
    expect(resetTimeLabel(20, new Date("2026-11-20T19:20:00Z"))).toEqual({ utc: "20:00 UTC", pacific: "12 PM Pacific", until: "next in under an hour" });
    expect(resetTimeLabel(3, new Date("2026-11-20T02:00:00Z"))).toEqual({ utc: "03:00 UTC", pacific: "7 PM Pacific", until: "next in about 1 hour" });
  });
});
