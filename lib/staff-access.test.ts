import { describe, expect, it } from "vitest";
import {
  checkSignIn,
  codeMatches,
  createSignInLimiter,
  issueStaffToken,
  safeNext,
  SIGN_IN_GLOBAL,
  SIGN_IN_PER_CLIENT,
  SIGN_IN_WINDOW_MS,
  STAFF_SESSION_SECONDS,
  staffAccessCode,
  verifyStaffToken,
} from "./staff-access";

const NOW = Date.parse("2026-11-20T09:00:00Z");

describe("staff cookie", () => {
  it("is valid for the code it was issued under, until it expires", () => {
    const { value, expires } = issueStaffToken("kestrel-counter-4821", NOW);
    expect(expires.getTime()).toBe(NOW + STAFF_SESSION_SECONDS * 1000);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW)).toBe(true);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW + STAFF_SESSION_SECONDS * 1000 - 1000)).toBe(true);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW + STAFF_SESSION_SECONDS * 1000)).toBe(false);
  });

  it("never contains the code", () => {
    const { value } = issueStaffToken("kestrel-counter-4821", NOW);
    expect(value).not.toContain("kestrel");
    expect(value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
  });

  it("is refused when missing, malformed or forged", () => {
    const { value } = issueStaffToken("kestrel-counter-4821", NOW);
    const [v, expires, mac] = value.split(".");
    expect(verifyStaffToken("kestrel-counter-4821", undefined, NOW)).toBe(false);
    expect(verifyStaffToken("kestrel-counter-4821", "", NOW)).toBe(false);
    expect(verifyStaffToken("kestrel-counter-4821", "kestrel-counter-4821", NOW)).toBe(false);
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(verifyStaffToken("kestrel-counter-4821", `${v}.${expires}.${flipped}`, NOW)).toBe(false);
    // Moving the expiry later breaks the MAC.
    expect(verifyStaffToken("kestrel-counter-4821", `${v}.${Number(expires) + 3600}.${mac}`, NOW)).toBe(false);
  });

  it("stops working when the code changes", () => {
    const { value } = issueStaffToken("kestrel-counter-4821", NOW);
    expect(verifyStaffToken("kestrel-counter-9999", value, NOW)).toBe(false);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW)).toBe(true);
  });

  it("reads the code from SHOP_ACCESS_CODE, treating empty as unset", () => {
    expect(staffAccessCode({})).toBeNull();
    expect(staffAccessCode({ SHOP_ACCESS_CODE: "   " })).toBeNull();
    expect(staffAccessCode({ SHOP_ACCESS_CODE: " open-sesame " })).toBe("open-sesame");
  });

  it("compares codes whatever their length", () => {
    expect(codeMatches("open-sesame", "open-sesame")).toBe(true);
    expect(codeMatches("open-sesame", " open-sesame ")).toBe(true);
    expect(codeMatches("open-sesame", "open")).toBe(false);
    expect(codeMatches("open-sesame", "")).toBe(false);
  });

  it("sends people back only to counter pages", () => {
    expect(safeNext("/shop/rentals/R-ABC234")).toBe("/shop/rentals/R-ABC234");
    expect(safeNext("/shop/schedule")).toBe("/shop/schedule");
    for (const bad of ["https://evil.example", "//evil.example", "/r/token", "/shop/sign-in", "/shop?x=1", "/shop/../api", null, ""]) {
      expect(safeNext(bad), String(bad)).toBe("/shop");
    }
  });
});

describe("signing in", () => {
  const env = { SHOP_ACCESS_CODE: "open-sesame" };

  it("issues a cookie for the right code and refuses a wrong one", async () => {
    const limits = createSignInLimiter();
    const wrong = await checkSignIn("open-sesam", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect(wrong).toEqual({ ok: false, error: "That is not the counter's access code." });
    const right = await checkSignIn("open-sesame", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect(right.ok && right.token && verifyStaffToken("open-sesame", right.token.value, NOW)).toBe(true);
  });

  it("needs no code when SHOP_ACCESS_CODE is unset", async () => {
    expect(await checkSignIn("anything", "1.2.3.4", { env: {}, delayMs: 0 })).toEqual({ ok: true, token: null });
  });

  it("makes one client wait after five wrong codes, even for the right one, until the window ends", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_PER_CLIENT; i++) await checkSignIn(`guess-${i}`, "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    const locked = await checkSignIn("open-sesame", "1.2.3.4", { env, limits, delayMs: 0, now: NOW + 60_000 });
    expect(locked).toEqual({ ok: false, error: "Too many wrong codes. Try again in 14 minutes." });
    // Another client is not affected.
    expect((await checkSignIn("open-sesame", "5.6.7.8", { env, limits, delayMs: 0, now: NOW + 60_000 })).ok).toBe(true);
    // After the window the first client may try again.
    expect((await checkSignIn("open-sesame", "1.2.3.4", { env, limits, delayMs: 0, now: NOW + SIGN_IN_WINDOW_MS })).ok).toBe(true);
  });

  it("forgets a client's wrong codes once it signs in", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_PER_CLIENT - 1; i++) await checkSignIn("nope", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect((await checkSignIn("open-sesame", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(true);
    expect((await checkSignIn("nope", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(false);
    expect((await checkSignIn("open-sesame", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(true);
  });

  it("stops everyone for the window after too many wrong codes in total, from any address", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_GLOBAL; i++) await checkSignIn("nope", `10.0.${Math.floor(i / 250)}.${i % 250}`, { env, limits, delayMs: 0, now: NOW });
    expect((await checkSignIn("open-sesame", "192.168.1.1", { env, limits, delayMs: 0, now: NOW })).ok).toBe(false);
    expect((await checkSignIn("open-sesame", "192.168.1.1", { env, limits, delayMs: 0, now: NOW + SIGN_IN_WINDOW_MS })).ok).toBe(true);
  });

  it("answers a wrong code slowly", async () => {
    const started = Date.now();
    await checkSignIn("nope", "1.2.3.4", { env, limits: createSignInLimiter(), delayMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });
});
