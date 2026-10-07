import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The link a refund draft gives: the rental page with the refund form filled
 * in (?refund=<cents>&capture=<id>&reason=...). Anyone can type such a URL,
 * so the parameters are signed when the deposit desk drafts them, and the
 * rental page fills the form in, and says the deposit desk drafted it, only
 * for a signature that checks out and has not expired. Filling a form in
 * sends nothing either way: a person still presses Refund and confirms.
 *
 * The key comes from STAFF_COOKIE_SECRET, else SHOP_ACCESS_CODE, else a
 * random key for this process (a local copy, whose links then last until a
 * restart).
 */

export type RefundDraft = { captureId: string; cents: number; reason: string };

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;
let processKey: Buffer | undefined;

function key(env: Env): Buffer {
  const secret = env.STAFF_COOKIE_SECRET || env.SHOP_ACCESS_CODE;
  if (secret) return createHash("sha256").update(`handback-refund-draft-v1:${secret}`).digest();
  processKey ??= randomBytes(32);
  return processKey;
}

const mac = (rentalId: string, d: RefundDraft, expires: number, env: Env) =>
  createHmac("sha256", key(env))
    .update(JSON.stringify([rentalId, d.captureId, d.cents, d.reason, expires]))
    .digest("base64url");

/** The query string for a draft on one rental, valid for a day. */
export function signDraft(rentalId: string, d: RefundDraft, now = Date.now(), env: Env = process.env): string {
  const expires = now + DRAFT_TTL_MS;
  return new URLSearchParams({ refund: String(d.cents), capture: d.captureId, reason: d.reason, exp: String(expires), sig: mac(rentalId, d, expires, env) }).toString();
}

/** The draft in a rental page's query, or null when there is none, it was altered, it is for another rental, or it expired. */
export function readDraft(rentalId: string, q: Record<string, string | string[] | undefined>, now = Date.now(), env: Env = process.env): RefundDraft | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const cents = Number(one(q.refund));
  const captureId = one(q.capture);
  const reason = one(q.reason) ?? "";
  const expires = Number(one(q.exp));
  const sig = one(q.sig);
  if (!Number.isSafeInteger(cents) || cents <= 0 || !captureId || !sig || reason.length > 200) return null;
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + DRAFT_TTL_MS + 60_000) return null;
  const expected = Buffer.from(mac(rentalId, { captureId, cents, reason }, expires, env));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { captureId, cents, reason };
}
