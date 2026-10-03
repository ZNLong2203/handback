import "server-only";
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { UserError } from "@/lib/rentals/types";

/**
 * The counter's shared access code. With SHOP_ACCESS_CODE set, every staff
 * page, staff server action and staff-only route checks for a staff cookie;
 * without it (local development, demo clones, CI, tests) the counter is open
 * as before. It is one code for the whole shop, not a staff account: it says
 * that whoever holds the cookie knew the code, not who they are.
 *
 * The cookie never holds the code. It holds an expiry time and an HMAC of it,
 * keyed by a key derived from the code, so a new code invalidates every
 * cookie issued under the old one, and the server enforces the lifetime as
 * well as the browser.
 */

export const STAFF_COOKIE = "handback_staff";

type Env = Record<string, string | undefined>;
/** One working day at the counter. */
export const STAFF_SESSION_SECONDS = 12 * 60 * 60;

/** The code, or null when the counter needs none. Surrounding spaces are ignored; an empty value means unset. */
export function staffAccessCode(env: Env = process.env): string | null {
  const code = env.SHOP_ACCESS_CODE?.trim();
  return code ? code : null;
}

/** PUBLIC_DEMO=true: a copy shared with hackathon judges, whose sign-in page may say where the code is published. */
export const isPublicDemo = (env: Env = process.env) => env.PUBLIC_DEMO === "true";

// scrypt makes each guess at the code expensive for someone who got hold of
// a cookie and tries codes offline. One key per process: the code only
// changes with a restart.
let derived: { code: string; key: Buffer } | null = null;
function keyFor(code: string): Buffer {
  if (derived?.code !== code) derived = { code, key: scryptSync(code, "handback-staff-cookie-v1", 32) };
  return derived.key;
}

const mac = (code: string, expires: number) => createHmac("sha256", keyFor(code)).update(`staff:${expires}`).digest("base64url");

/** A cookie value for someone who just entered the right code: `v1.<expiry, unix seconds>.<hmac>`. */
export function issueStaffToken(code: string, now = Date.now()): { value: string; expires: Date } {
  const expires = Math.floor(now / 1000) + STAFF_SESSION_SECONDS;
  return { value: `v1.${expires}.${mac(code, expires)}`, expires: new Date(expires * 1000) };
}

/** True when the cookie was issued under this code and has not expired. Compares in constant time. */
export function verifyStaffToken(code: string, token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= now || expires * 1000 > now + STAFF_SESSION_SECONDS * 1000 + 60_000) return false;
  const expected = Buffer.from(mac(code, expires));
  const given = Buffer.from(match[2]);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Compares an attempt with the code in constant time, whatever their lengths. */
export function codeMatches(code: string, attempt: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(code), digest(attempt.trim()));
}

// ─── Wrong codes ────────────────────────────────────────────

export const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** Wrong codes one client may enter per window before it has to wait. */
export const SIGN_IN_PER_CLIENT = 5;
/** Wrong codes from everyone together per window, a ceiling for clients that change their address. */
export const SIGN_IN_GLOBAL = 100;

type Bucket = { failures: number; since: number };

/**
 * Counts wrong codes in this process, per client and in total, over a fixed
 * 15-minute window. In-memory on purpose: the app runs as one instance, and a
 * restart forgets the counts.
 */
export function createSignInLimiter() {
  const clients = new Map<string, Bucket>();
  let all: Bucket = { failures: 0, since: 0 };
  const fresh = (b: Bucket | undefined, now: number): Bucket => (b && now - b.since < SIGN_IN_WINDOW_MS ? b : { failures: 0, since: now });
  return {
    /** Milliseconds until this client may try again, or 0. */
    waitMs(client: string, now = Date.now()): number {
      const own = fresh(clients.get(client), now);
      all = fresh(all, now);
      const waits = [
        own.failures >= SIGN_IN_PER_CLIENT ? own.since + SIGN_IN_WINDOW_MS - now : 0,
        all.failures >= SIGN_IN_GLOBAL ? all.since + SIGN_IN_WINDOW_MS - now : 0,
      ];
      return Math.max(...waits);
    },
    fail(client: string, now = Date.now()): void {
      const own = fresh(clients.get(client), now);
      own.failures += 1;
      clients.set(client, own);
      all = fresh(all, now);
      all.failures += 1;
      if (clients.size > 10_000) for (const [k, b] of clients) if (now - b.since >= SIGN_IN_WINDOW_MS) clients.delete(k);
    },
    succeed(client: string): void {
      clients.delete(client);
    },
  };
}

const globalForLimiter = globalThis as unknown as { handbackSignIn?: ReturnType<typeof createSignInLimiter> };
const limiter = (globalForLimiter.handbackSignIn ??= createSignInLimiter());

/** How long a wrong code takes to be answered, so guessing one after another is slow. */
export const WRONG_CODE_DELAY_MS = 1000;

/** `token` is null when the counter needs no code. */
export type SignInResult = { ok: true; token: { value: string; expires: Date } | null } | { ok: false; error: string };

/** Checks an entered code for one client. `client` is the address the proxy reports; see clientAddress. */
export async function checkSignIn(
  attempt: string,
  client: string,
  opts: { env?: Env; now?: number; delayMs?: number; limits?: ReturnType<typeof createSignInLimiter> } = {},
): Promise<SignInResult> {
  const code = staffAccessCode(opts.env);
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? limiter;
  if (!code) return { ok: true, token: null };
  const wait = limits.waitMs(client, now);
  if (wait > 0) {
    const minutes = Math.max(1, Math.ceil(wait / 60_000));
    return { ok: false, error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }
  if (!codeMatches(code, attempt)) {
    limits.fail(client, now);
    const delay = opts.delayMs ?? WRONG_CODE_DELAY_MS;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { ok: false, error: "That is not the counter's access code." };
  }
  limits.succeed(client);
  return { ok: true, token: issueStaffToken(code, now) };
}

// ─── In requests ────────────────────────────────────────────

/** Thrown by requireStaff; server actions return its message like any other UserError. */
export class StaffAccessError extends UserError {
  constructor() {
    super("Staff sign-in needed: open the counter and enter the access code. Nothing was changed.");
    this.name = "StaffAccessError";
  }
}

/** Whether this request may act as staff. Always true without SHOP_ACCESS_CODE, without reading cookies. */
export async function isStaff(): Promise<boolean> {
  const code = staffAccessCode();
  if (!code) return true;
  const jar = await cookies();
  return verifyStaffToken(code, jar.get(STAFF_COOKIE)?.value);
}

/** The first line of every staff server action: refuses before anything is read or changed. */
export async function requireStaff(): Promise<void> {
  if (!(await isStaff())) throw new StaffAccessError();
}

/** Where sign-in may send someone back to: a counter page, never another site or the sign-in page itself. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !/^\/shop(\/[A-Za-z0-9/_-]*)?$/.test(next) || next.startsWith("/shop/sign-in")) return "/shop";
  return next;
}

/** The first line of every staff page: without a valid cookie, go to the sign-in page and come back here. */
export async function requireStaffPage(path: string): Promise<void> {
  if (!(await isStaff())) redirect(`/shop/sign-in?next=${encodeURIComponent(safeNext(path))}`);
}

/** For staff-only route handlers. */
export async function staffOnlyResponse(): Promise<Response | null> {
  if (await isStaff()) return null;
  return Response.json({ error: "Staff sign-in needed" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** The client address the proxy in front reports (first X-Forwarded-For entry); best effort, used only to count wrong codes. */
export async function clientAddress(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Secure cookies when the request reached us over https (Render terminates TLS and says so in X-Forwarded-Proto). */
export async function servedOverHttps(): Promise<boolean> {
  const h = await headers();
  return (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}
