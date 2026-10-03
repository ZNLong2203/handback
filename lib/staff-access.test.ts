import { describe, expect, it } from "vitest";
import {
  checkSignIn,
  clientAddressFrom,
  codeMatches,
  createSignInLimiter,
  issueStaffToken,
  safeNext,
  SIGN_IN_GLOBAL,
  SIGN_IN_PER_CLIENT,
  SIGN_IN_WINDOW_MS,
  STAFF_SESSION_SECONDS,
  staffAccess,
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

  it("reads the code from SHOP_ACCESS_CODE: empty is unset, and a code that is set but too short closes the counter", () => {
    expect(staffAccess({})).toEqual({ mode: "open" });
    expect(staffAccess({ SHOP_ACCESS_CODE: "" })).toEqual({ mode: "open" });
    expect(staffAccess({ SHOP_ACCESS_CODE: "   " })).toEqual({ mode: "misconfigured", problem: "SHOP_ACCESS_CODE is only spaces." });
    expect(staffAccess({ SHOP_ACCESS_CODE: "1234" })).toEqual({ mode: "misconfigured", problem: "SHOP_ACCESS_CODE has 4 characters; it needs at least 12." });
    expect(staffAccess({ SHOP_ACCESS_CODE: " open-sesame-door " })).toEqual({ mode: "code", code: "open-sesame-door" });
    expect(staffAccessCode({ SHOP_ACCESS_CODE: "1234" })).toBeNull();
  });

  it("with a server secret, needs that secret too, so a cookie alone cannot be checked against guessed codes", () => {
    const { value } = issueStaffToken("kestrel-counter-4821", NOW, "server-secret-a");
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW, "server-secret-a")).toBe(true);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW, "server-secret-b")).toBe(false);
    expect(verifyStaffToken("kestrel-counter-4821", value, NOW, "")).toBe(false);
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
  const env = { SHOP_ACCESS_CODE: "open-sesame-door" };

  it("issues a cookie for the right code and refuses a wrong one", async () => {
    const limits = createSignInLimiter();
    const wrong = await checkSignIn("open-sesam", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect(wrong).toEqual({ ok: false, error: "That is not the counter's access code." });
    const right = await checkSignIn("open-sesame-door", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect(right.ok && right.token && verifyStaffToken("open-sesame-door", right.token.value, NOW)).toBe(true);
  });

  it("needs no code when SHOP_ACCESS_CODE is unset", async () => {
    expect(await checkSignIn("anything", "1.2.3.4", { env: {}, delayMs: 0 })).toEqual({ ok: true, token: null });
  });

  it("makes one client wait after five wrong codes, even for the right one, until the window ends", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_PER_CLIENT; i++) await checkSignIn(`guess-${i}`, "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    const locked = await checkSignIn("open-sesame-door", "1.2.3.4", { env, limits, delayMs: 0, now: NOW + 60_000 });
    expect(locked).toEqual({ ok: false, error: "Too many wrong codes. Try again in 14 minutes." });
    // Another client is not affected.
    expect((await checkSignIn("open-sesame-door", "5.6.7.8", { env, limits, delayMs: 0, now: NOW + 60_000 })).ok).toBe(true);
    // After the window the first client may try again.
    expect((await checkSignIn("open-sesame-door", "1.2.3.4", { env, limits, delayMs: 0, now: NOW + SIGN_IN_WINDOW_MS })).ok).toBe(true);
  });

  it("forgets a client's wrong codes once it signs in", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_PER_CLIENT - 1; i++) await checkSignIn("nope", "1.2.3.4", { env, limits, delayMs: 0, now: NOW });
    expect((await checkSignIn("open-sesame-door", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(true);
    expect((await checkSignIn("nope", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(false);
    expect((await checkSignIn("open-sesame-door", "1.2.3.4", { env, limits, delayMs: 0, now: NOW })).ok).toBe(true);
  });

  it("stops everyone for the window after too many wrong codes in total, from any address", async () => {
    const limits = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_GLOBAL; i++) await checkSignIn("nope", `10.0.${Math.floor(i / 250)}.${i % 250}`, { env, limits, delayMs: 0, now: NOW });
    expect((await checkSignIn("open-sesame-door", "192.168.1.1", { env, limits, delayMs: 0, now: NOW })).ok).toBe(false);
    expect((await checkSignIn("open-sesame-door", "192.168.1.1", { env, limits, delayMs: 0, now: NOW + SIGN_IN_WINDOW_MS })).ok).toBe(true);
  });

  it("lets nobody in while the code is too short", async () => {
    const result = await checkSignIn("1234", "1.2.3.4", { env: { SHOP_ACCESS_CODE: "1234" }, limits: createSignInLimiter(), delayMs: 0 });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not set up correctly/) });
  });

  it("counts wrong codes against the address the proxy added, not the one the client wrote", async () => {
    const limits = createSignInLimiter();
    const results = [];
    for (let i = 0; i < SIGN_IN_PER_CLIENT + 1; i++) {
      // The client writes a new address each time; the proxy appends the one it saw.
      const client = clientAddressFrom(new Headers({ "x-forwarded-for": `10.9.8.${i}, 203.0.113.7` }), {});
      results.push(await checkSignIn(i === SIGN_IN_PER_CLIENT ? "open-sesame-door" : "guess", client, { env, limits, delayMs: 0, now: NOW }));
    }
    expect(results.at(-1)).toEqual({ ok: false, error: expect.stringMatching(/Too many wrong codes/) });
  });

  it("answers a wrong code slowly", async () => {
    const started = Date.now();
    await checkSignIn("nope", "1.2.3.4", { env, limits: createSignInLimiter(), delayMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });
});

describe("the client address", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("is the last X-Forwarded-For entry, or TRUSTED_PROXY_HOPS before it", () => {
    expect(clientAddressFrom(h({ "x-forwarded-for": "203.0.113.7" }), {})).toBe("203.0.113.7");
    expect(clientAddressFrom(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }), {})).toBe("203.0.113.7");
    expect(clientAddressFrom(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 172.70.1.1" }), { TRUSTED_PROXY_HOPS: "1" })).toBe("203.0.113.7");
    expect(clientAddressFrom(h({ "x-forwarded-for": "203.0.113.7" }), { TRUSTED_PROXY_HOPS: "5" })).toBe("203.0.113.7");
    expect(clientAddressFrom(h({ "x-forwarded-for": "203.0.113.7" }), { TRUSTED_PROXY_HOPS: "nonsense" })).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP, then to one shared bucket", () => {
    expect(clientAddressFrom(h({ "x-real-ip": "198.51.100.2" }), {})).toBe("198.51.100.2");
    expect(clientAddressFrom(h({}), {})).toBe("unknown");
  });
});
