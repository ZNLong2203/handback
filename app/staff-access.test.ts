// The counter's access code end to end on the server side: every staff
// server action and staff-only route refuses without the staff cookie when
// SHOP_ACCESS_CODE is set, and nothing changes when it is unset. Demo mode,
// in-memory database; next/headers is replaced by a fake cookie jar.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  reads: 0,
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
  headers: {} as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    jar.reads++;
    return {
      get: (name: string) => (name === "handback_staff" && jar.cookie ? { name, value: jar.cookie } : undefined),
      set: (name: string, value: string, options: Record<string, unknown>) => jar.set.push({ name, value, options }),
      delete: () => {},
    };
  },
  headers: async () => new Headers(jar.headers),
}));
// redirect() ends a server action by throwing; the test sees where it went.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect ${url}`), { redirectTo: url });
  },
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.SHOP_ACCESS_CODE;

const actions = await import("@/app/actions");
const scheduleActions = await import("@/app/shop/schedule/actions");
const live = await import("@/app/api/live/[channel]/route");
const evidence = await import("@/app/api/evidence/[sha]/route");
const { getDb } = await import("@/lib/db/client");
const { rentalById } = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");
const { issueStaffToken, signInTiming, verifyStaffToken } = await import("@/lib/staff-access");
const { signInAction } = await import("@/app/shop/sign-in/actions");
signInTiming.wrongCodeDelayMs = 0;
const CODE = "open-sesame-door";
const { spacedDates } = await import("@/test/dates");

/** The renter's side: anyone may call these, as before. */
const CUSTOMER_ACTIONS = ["startBookingAction", "confirmBookingAction", "acknowledgeCheckoutAction", "respondAction"];
const REFUSED = /Staff sign-in needed/;

async function bookedWithPhoto() {
  const { rentalId, orderId } = await svc.startBooking({ itemId: "camera-kit", name: "Maya Chen", email: "maya@example.com", ...spacedDates() });
  await svc.confirmBooking(orderId);
  await svc.addPhoto(rentalId, "checkout", { sample: "camera-kit/before" });
  return rentalId;
}

const status = async (id: string) => (await rentalById(await getDb(), id))!.status;

beforeAll(async () => {
  await getDb();
});

afterEach(() => {
  delete process.env.SHOP_ACCESS_CODE;
  jar.cookie = undefined;
  jar.reads = 0;
  jar.set = [];
  jar.headers = {};
});

/** Posts the sign-in form; returns the error shown, or where the action redirected. */
async function signIn(code: string, next: string): Promise<{ error: string | null } | { redirectTo: string }> {
  const form = new FormData();
  form.set("code", code);
  form.set("next", next);
  try {
    return await signInAction({ error: null }, form);
  } catch (err) {
    const to = (err as { redirectTo?: string }).redirectTo;
    if (to) return { redirectTo: to };
    throw err;
  }
}

describe("with SHOP_ACCESS_CODE set", () => {
  it("every staff action in app/actions.ts refuses without the cookie, before touching anything", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    const staffActions = Object.entries(actions).filter(([name, fn]) => typeof fn === "function" && !CUSTOMER_ACTIONS.includes(name));
    expect(staffActions.map(([name]) => name)).toEqual(expect.arrayContaining(["holdDepositAction", "settleAction", "addPhotoAction", "acceptClaimAction"]));
    for (const [name, fn] of staffActions) {
      const arg = name === "addPhotoAction" ? new FormData() : "R-NONE22";
      const result = await (fn as (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>)(arg, "x", "keep");
      expect(result, name).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    }
  });

  it("every schedule action refuses without the cookie", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    const all = Object.entries(scheduleActions).filter(([, fn]) => typeof fn === "function");
    expect(all.map(([name]) => name).sort()).toEqual(["approveProposalAction", "commandAction", "moveRentalAction", "rejectProposalAction"]);
    for (const [name, fn] of all) {
      const result = await (fn as (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>)("x", "y");
      expect(result, name).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    }
  });

  it("holds the deposit only for a valid cookie, and not after the code changes", async () => {
    const rentalId = await bookedWithPhoto();
    process.env.SHOP_ACCESS_CODE = CODE;

    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    jar.cookie = "v1.9999999999.forged";
    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    expect(await status(rentalId)).toBe("booked");

    // A cookie issued before the code was changed no longer works.
    jar.cookie = issueStaffToken("an-older-code").value;
    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    expect(await status(rentalId)).toBe("booked");

    jar.cookie = issueStaffToken(CODE).value;
    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: true, data: undefined });
    expect(await status(rentalId)).toBe("out");
  });

  it("leaves the renter's actions open", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    const result = await actions.respondAction("no-such-token", []);
    expect(result).toEqual({ ok: false, error: "This link is not valid." });
  });

  it("closes the shop's live channel and the evidence packs, not a rental's own channel", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    const open = (channel: string) => live.GET(new Request(`http://localhost/api/live/${channel}`), { params: Promise.resolve({ channel }) });
    const pack = () => evidence.GET(new Request("http://localhost/api/evidence/abc"), { params: Promise.resolve({ sha: "abc" }) });

    expect((await open("shop")).status).toBe(401);
    expect((await pack()).status).toBe(401);
    const rentalChannel = await open("R-ABC234");
    expect(rentalChannel.status).toBe(200);
    await rentalChannel.body?.cancel();

    jar.cookie = issueStaffToken(CODE).value;
    const shop = await open("shop");
    expect(shop.status).toBe(200);
    await shop.body?.cancel();
    expect((await pack()).status).toBe(404);
  });
});

describe("signing in", () => {
  it("sets an httpOnly, lax, path-wide cookie for the right code and goes back to the counter page asked for", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    jar.headers = { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.1" };
    expect(await signIn(` ${CODE} `, "/shop/rentals/R-ABC234")).toEqual({ redirectTo: "/shop/rentals/R-ABC234" });
    expect(jar.set).toHaveLength(1);
    const [cookie] = jar.set;
    expect(cookie).toMatchObject({ name: "handback_staff", options: { httpOnly: true, sameSite: "lax", secure: true, path: "/" } });
    expect(cookie.value).not.toContain(CODE);
    expect(verifyStaffToken(CODE, cookie.value)).toBe(true);
    const hours = ((cookie.options.expires as Date).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it("marks the cookie secure only when the request came over https", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    jar.headers = { "x-forwarded-proto": "http", "x-forwarded-for": "198.51.100.2" };
    await signIn(CODE, "/shop");
    expect(jar.set[0].options).toMatchObject({ secure: false });
  });

  it("never sends someone off the counter after signing in", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    jar.headers = { "x-forwarded-for": "198.51.100.3" };
    expect(await signIn(CODE, "https://evil.example/shop")).toEqual({ redirectTo: "/shop" });
    expect(await signIn(CODE, "//evil.example")).toEqual({ redirectTo: "/shop" });
    expect(await signIn(CODE, "/r/some-renter-token")).toEqual({ redirectTo: "/shop" });
  });

  it("refuses a wrong code without a cookie, and counts it against the address the proxy added", async () => {
    process.env.SHOP_ACCESS_CODE = CODE;
    for (let i = 0; i < 5; i++) {
      jar.headers = { "x-forwarded-for": `10.0.0.${i}, 203.0.113.50` };
      expect(await signIn("not-the-code", "/shop")).toEqual({ error: "That is not the counter's access code." });
    }
    jar.headers = { "x-forwarded-for": "10.0.0.99, 203.0.113.50" };
    expect(await signIn(CODE, "/shop")).toEqual({ error: expect.stringMatching(/Too many wrong codes/) });
    expect(jar.set).toEqual([]);
    // Someone else at another address is not affected.
    jar.headers = { "x-forwarded-for": "203.0.113.51" };
    expect(await signIn(CODE, "/shop")).toEqual({ redirectTo: "/shop" });
  });

  it("closes the counter to everyone while the code is too short, cookie or not", async () => {
    const rentalId = await bookedWithPhoto();
    process.env.SHOP_ACCESS_CODE = "1234";
    jar.headers = { "x-forwarded-for": "198.51.100.9" };
    expect(await signIn("1234", "/shop")).toEqual({ error: expect.stringMatching(/not set up correctly/) });
    jar.cookie = issueStaffToken("1234").value;
    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: false, error: expect.stringMatching(REFUSED) });
    expect(await status(rentalId)).toBe("booked");
  });

  it("does nothing but go to the counter when no code is set", async () => {
    expect(await signIn("anything", "/shop/schedule")).toEqual({ redirectTo: "/shop/schedule" });
    expect(jar.set).toEqual([]);
  });
});

describe("with SHOP_ACCESS_CODE unset", () => {
  it("runs staff actions as before, without reading any cookie", async () => {
    const rentalId = await bookedWithPhoto();
    expect(await actions.holdDepositAction(rentalId)).toEqual({ ok: true, data: undefined });
    expect(await status(rentalId)).toBe("out");
    expect(jar.reads).toBe(0);
  });

  it("keeps the shop's live channel open", async () => {
    const res = await live.GET(new Request("http://localhost/api/live/shop"), { params: Promise.resolve({ channel: "shop" }) });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(jar.reads).toBe(0);
  });
});
