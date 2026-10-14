// The AG Studio licence key's deactivation date, read on the server so an
// expired evaluation key is never handed to AG Studio. The keys below have
// the shape of AG's evaluation keys with made-up letters around the date;
// none of them is a real key.
import { describe, expect, it } from "vitest";
import { agStudioLicense, licenseDateLabel, licenseDeactivationDate, licenseHealth, readDate, warnIfExpired } from "./license";

const FAKE_HASH = "0123456789abcdef0123456789abcdef";
const fakeKey = (middle: string) =>
  `[TRIAL]_this_{AG_Studio}_key_{AG-000000}_is_granted_for_evaluation_only___Use_in_production_is_not_permitted___Please_report_misuse_to_nobody@example.com___You_are_granted_a_{Single_Application}_Developer_License_for_one_application_only___${middle}____[v3]_[0102]_[03C]_WFhYWFhYWFhYWFhY${FAKE_HASH}`;

const KEY_NOV_28 = fakeKey("This_key_will_deactivate_on_{28 November 2026}");

describe("licenseDeactivationDate", () => {
  it("reads the date in the evaluation key's own words", () => {
    expect(licenseDeactivationDate(KEY_NOV_28)).toBe("2026-11-28");
  });

  it("tolerates the other ways a key could write it", () => {
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{28_November_2026}"))).toBe("2026-11-28");
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{28th Nov, 2026}"))).toBe("2026-11-28");
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{November 28, 2026}"))).toBe("2026-11-28");
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{2026-11-28}"))).toBe("2026-11-28");
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_28_November_2026"))).toBe("2026-11-28");
    expect(licenseDeactivationDate(fakeKey("This_key_expires_on_{1 December 2026}"))).toBe("2026-12-01");
    expect(licenseDeactivationDate(fakeKey("this_key_will_DEACTIVATE_ON_{3 jan 2027}"))).toBe("2027-01-03");
  });

  it("is null when the key names no date it can read", () => {
    // A production key says nothing about deactivating.
    expect(licenseDeactivationDate(fakeKey("This_key_works_with_{AG_Studio}_versions_released_before_{28 November 2026}"))).toBeNull();
    expect(licenseDeactivationDate("")).toBeNull();
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{soon}"))).toBeNull();
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{31 February 2026}"))).toBeNull();
    // Day and month order is ambiguous in 11/12/2026, so it is not guessed.
    expect(licenseDeactivationDate(fakeKey("This_key_will_deactivate_on_{11/12/2026}"))).toBeNull();
    expect(readDate("28 Smarch 2026")).toBeNull();
  });
});

describe("agStudioLicense", () => {
  const env = (key?: string) => ({ AG_STUDIO_LICENSE_KEY: key });

  it("is none without a key", () => {
    expect(agStudioLicense(env(undefined))).toEqual({ state: "none" });
    expect(agStudioLicense(env("   "))).toEqual({ state: "none" });
  });

  it("passes a key with a future date on, with the date", () => {
    expect(agStudioLicense(env(` ${KEY_NOV_28}\n`), new Date("2026-11-27T23:59:59Z"))).toEqual({ state: "valid", key: KEY_NOV_28, until: "2026-11-28" });
  });

  it("holds an expired key back from the day it names, as AG Studio counts it", () => {
    expect(agStudioLicense(env(KEY_NOV_28), new Date("2026-11-28T00:00:00Z"))).toEqual({ state: "expired", expiredOn: "2026-11-28" });
    expect(agStudioLicense(env(KEY_NOV_28), new Date("2026-12-15T18:00:00Z"))).toEqual({ state: "expired", expiredOn: "2026-11-28" });
  });

  it("treats a key whose date cannot be read as valid", () => {
    const key = fakeKey("This_key_will_deactivate_on_{someday}");
    expect(agStudioLicense(env(key), new Date("2030-01-01T00:00:00Z"))).toEqual({ state: "valid", key, until: null });
  });

  it("reports the state for /api/health without the key", () => {
    const valid = licenseHealth(env(KEY_NOV_28), new Date("2026-10-14T09:00:00Z"));
    expect(valid).toEqual({ state: "valid", until: "2026-11-28" });
    expect(licenseHealth(env(KEY_NOV_28), new Date("2026-11-30T09:00:00Z"))).toEqual({ state: "expired", expiredOn: "2026-11-28" });
    expect(licenseHealth(env())).toEqual({ state: "none" });
    expect(JSON.stringify(valid)).not.toContain("AG-000000");
  });
});

describe("the expiry warning", () => {
  it("is logged once per process, and never with the key", () => {
    const lines: string[] = [];
    const expired = agStudioLicense({ AG_STUDIO_LICENSE_KEY: KEY_NOV_28 }, new Date("2026-12-01T00:00:00Z"));
    warnIfExpired({ state: "valid", key: KEY_NOV_28, until: "2026-11-28" }, (l) => lines.push(l));
    expect(lines).toEqual([]);
    warnIfExpired(expired, (l) => lines.push(l));
    warnIfExpired(expired, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deactivated on 2026-11-28.*keyless trial/);
    expect(lines[0]).not.toContain("AG-000000");
    expect(licenseDateLabel("2026-11-28")).toBe("November 28, 2026");
  });
});
