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
 * keyed by a key derived from the code (scrypt) and, when STAFF_COOKIE_SECRET
 * is set, from that server-side secret too, so a leaked cookie cannot be
 * turned into the code by guessing offline. A new code or secret invalidates
 * every cookie issued under the old one, and the server enforces the lifetime
 * as well as the browser.
 *
 * A code that is set but too short (under MIN_CODE_LENGTH characters, or only
 * spaces) closes the counter to everyone rather than opening it: whoever set
 * it meant to protect the counter.
 */

export const STAFF_COOKIE = "handback_staff";

type Env = Record<string, string | undefined>;
/** One working day at the counter. */
export const STAFF_SESSION_SECONDS = 12 * 60 * 60;

export const MIN_CODE_LENGTH = 12;

export type StaffAccess = { mode: "open" } | { mode: "code"; code: string } | { mode: "misconfigured"; problem: string };

let warned = false;

/** How the counter is protected. Unset or empty: open. Set: the code, with surrounding spaces ignored, if it is long enough. */
export function staffAccess(env: Env = process.env): StaffAccess {
  const raw = env.SHOP_ACCESS_CODE;
  if (raw === undefined || raw === "") return { mode: "open" };
  const code = raw.trim();
  if (code.length >= MIN_CODE_LENGTH) return { mode: "code", code };
  const problem = code
    ? `SHOP_ACCESS_CODE has ${code.length} characters; it needs at least ${MIN_CODE_LENGTH}.`
    : "SHOP_ACCESS_CODE is only spaces.";
  if (!warned && env === process.env) {
    warned = true;
    console.error(`${problem} The counter is closed to everyone until it is fixed.`);
  }
  return { mode: "misconfigured", problem };
}

/** The code when the counter has a usable one, else null (open, or closed by a code that is too short). */
export function staffAccessCode(env: Env = process.env): string | null {
  const access = staffAccess(env);
  return access.mode === "code" ? access.code : null;
}

/** PUBLIC_DEMO=true: a copy shared with hackathon judges, whose sign-in page may say where the code is published. */
export const isPublicDemo = (env: Env = process.env) => env.PUBLIC_DEMO === "true";

const cookieSecret = (env: Env = process.env) => env.STAFF_COOKIE_SECRET || "";

// scrypt makes each guess at the code expensive; the server secret, where
// there is one, makes a cookie useless for guessing without it. One key per
// process and code: the values only change with a restart.
let derived: { code: string; secret: string; key: Buffer } | null = null;
function keyFor(code: string, secret: string): Buffer {
  if (derived?.code !== code || derived.secret !== secret) {
    const slow = scryptSync(code, "handback-staff-cookie-v1", 32);
    derived = { code, secret, key: secret ? createHmac("sha256", secret).update(slow).digest() : slow };
  }
  return derived.key;
}

const mac = (code: string, secret: string, expires: number) => createHmac("sha256", keyFor(code, secret)).update(`staff:${expires}`).digest("base64url");

/** A cookie value for someone who just entered the right code: `v1.<expiry, unix seconds>.<hmac>`. */
export function issueStaffToken(code: string, now = Date.now(), secret = cookieSecret()): { value: string; expires: Date } {
  const expires = Math.floor(now / 1000) + STAFF_SESSION_SECONDS;
  return { value: `v1.${expires}.${mac(code, secret, expires)}`, expires: new Date(expires * 1000) };
}

/** True when the cookie was issued under this code (and secret) and has not expired. Compares in constant time. */
export function verifyStaffToken(code: string, token: string | undefined | null, now = Date.now(), secret = cookieSecret()): boolean {
  if (!token) return false;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= now || expires * 1000 > now + STAFF_SESSION_SECONDS * 1000 + 60_000) return false;
  const expected = Buffer.from(mac(code, secret, expires));
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
/**
 * Wrong codes from everyone together per window. This is what bounds guessing:
 * the per-client count relies on the address the proxy reports, which a client
 * may be able to vary. With a code of at least 12 characters, 100 guesses per
 * 15 minutes cannot find it.
 */
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
    /** True while the global ceiling stops every sign-in. */
    locked(now = Date.now()): boolean {
      all = fresh(all, now);
      return all.failures >= SIGN_IN_GLOBAL;
    },
  };
}

const globalForLimiter = globalThis as unknown as { handbackSignIn?: ReturnType<typeof createSignInLimiter> };
const limiter = (globalForLimiter.handbackSignIn ??= createSignInLimiter());

/** How long a wrong code takes to be answered, so guessing one after another is slow. Tests set it to 0. */
export const signInTiming = { wrongCodeDelayMs: 1000 };

/** For /api/health: whether too many wrong codes have stopped every sign-in for now. */
export const signInLocked = () => limiter.locked();

/** `token` is null when the counter needs no code. */
export type SignInResult = { ok: true; token: { value: string; expires: Date } | null } | { ok: false; error: string };

/** Checks an entered code for one client. `client` is the address the proxy reports; see clientAddress. */
export async function checkSignIn(
  attempt: string,
  client: string,
  opts: { env?: Env; now?: number; delayMs?: number; limits?: ReturnType<typeof createSignInLimiter> } = {},
): Promise<SignInResult> {
  const access = staffAccess(opts.env);
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? limiter;
  if (access.mode === "open") return { ok: true, token: null };
  if (access.mode === "misconfigured") return { ok: false, error: "The counter's access code is not set up correctly, so nobody can sign in. The shop has to fix SHOP_ACCESS_CODE." };
  const code = access.code;
  const wait = limits.waitMs(client, now);
  if (wait > 0) {
    const minutes = Math.max(1, Math.ceil(wait / 60_000));
    return { ok: false, error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }
  if (!codeMatches(code, attempt)) {
    limits.fail(client, now);
    const delay = opts.delayMs ?? signInTiming.wrongCodeDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { ok: false, error: "That is not the counter's access code." };
  }
  limits.succeed(client);
  return { ok: true, token: issueStaffToken(code, now, cookieSecret(opts.env ?? process.env)) };
}

// ─── In requests ────────────────────────────────────────────

/** Thrown by requireStaff; server actions return its message like any other UserError. */
export class StaffAccessError extends UserError {
  constructor() {
    super("Staff sign-in needed: open the counter and enter the access code. Nothing was changed.");
    this.name = "StaffAccessError";
  }
}

/** Whether this request may act as staff. Always true without SHOP_ACCESS_CODE (no cookie is read); never with a code that is too short. */
export async function isStaff(): Promise<boolean> {
  const access = staffAccess();
  if (access.mode === "open") return true;
  if (access.mode === "misconfigured") return false;
  const jar = await cookies();
  return verifyStaffToken(access.code, jar.get(STAFF_COOKIE)?.value);
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

/**
 * The address wrong codes are counted against. Proxies append to
 * X-Forwarded-For and keep whatever the client sent, so the first entry is
 * the client's to choose. This takes the entry the nearest trusted proxy
 * added: the last one, or TRUSTED_PROXY_HOPS entries before it when more
 * proxies of our own append after it. Render's documentation says to read the
 * client address from X-Forwarded-For but not how many entries its proxies add;
 * /api/health shows the address this picks, to check after deploying. Next.js
 * sets the header to the socket address when no proxy did.
 */
export function clientAddressFrom(h: Headers, env: Env = process.env): string {
  const hops = Math.max(0, Math.floor(Number(env.TRUSTED_PROXY_HOPS ?? 0)) || 0);
  const entries = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length > 0) return entries[Math.max(0, entries.length - 1 - hops)];
  return h.get("x-real-ip")?.trim() || "unknown";
}

export async function clientAddress(): Promise<string> {
  return clientAddressFrom(await headers());
}

/** Secure cookies when the request reached us over https (Render terminates TLS and says so in X-Forwarded-Proto). */
export async function servedOverHttps(): Promise<boolean> {
  const h = await headers();
  return (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}
