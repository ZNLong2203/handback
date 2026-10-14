import "server-only";
import { todayIso } from "@/lib/dates";

/**
 * The AG Studio licence key, read on the server. An evaluation key says in
 * its own text when it stops working ("This_key_will_deactivate_on_{28
 * November 2026}"); AG Studio's licence check compares the date encoded at
 * the end of the key with the browser's clock, from 00:00 UTC that day.
 *
 * An expired key is not passed to AgStudioProvider: the dashboard then runs
 * as the keyless trial, which AG Studio documents ("For Trial Use Only"
 * watermark, hidden on localhost), instead of whatever it does with a key it
 * considers expired. A key whose date cannot be read is treated as valid,
 * as before this check existed.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A real calendar day as YYYY-MM-DD, or null (31 February is not a day). */
function day(year: number, month: number, date: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || month < 1 || month > 12 || date < 1 || date > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, date));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === date ? d.toISOString().slice(0, 10) : null;
}

const month = (name: string): number => {
  const n = name.toLowerCase();
  if (n.length < 3) return 0;
  return MONTHS.findIndex((m) => m.startsWith(n)) + 1;
};

/**
 * A date written the ways a key might write it: "28 November 2026",
 * "28_Nov_2026", "28th November, 2026", "November 28 2026" or "2026-11-28".
 * Numeric day/month orders other than ISO are ambiguous, so they are not read.
 */
export function readDate(text: string): string | null {
  const t = text
    .replace(/[_,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9}) (\d{4})$/i.exec(t);
  if (m) return month(m[2]) ? day(Number(m[3]), month(m[2]), Number(m[1])) : null;
  m = /^([A-Za-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/i.exec(t);
  if (m) return month(m[1]) ? day(Number(m[3]), month(m[1]), Number(m[2])) : null;
  return null;
}

/**
 * The day the key says it deactivates, as YYYY-MM-DD, or null when it names
 * none that can be read. Looks for "deactivate(s) on" (or "expire(s) on")
 * followed by a date in braces, or by the date itself.
 */
export function licenseDeactivationDate(key: string): string | null {
  const braced = /(?:deactivate|expire)s?[\s_]+on[\s_]*\{([^{}]{6,40})\}/i.exec(key);
  if (braced) return readDate(braced[1]);
  const bare = /(?:deactivate|expire)s?[\s_]+on[\s_]+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}(?:st|nd|rd|th)?[\s_]+[A-Za-z]{3,9},?[\s_]+\d{4}|[A-Za-z]{3,9}[\s_]+\d{1,2}(?:st|nd|rd|th)?,?[\s_]+\d{4})/i.exec(key);
  return bare ? readDate(bare[1]) : null;
}

export type AgStudioLicense =
  | { state: "none" }
  /** `until` is null when the key names no date that can be read. */
  | { state: "valid"; key: string; until: string | null }
  | { state: "expired"; expiredOn: string };

/**
 * AG_STUDIO_LICENSE_KEY and what to do with it today. Expired from the day it
 * names (UTC), the way AG Studio counts it: a key that deactivates on Nov 28
 * is already refused on Nov 28.
 */
export function agStudioLicense(env: Record<string, string | undefined> = process.env, now = new Date()): AgStudioLicense {
  const key = env.AG_STUDIO_LICENSE_KEY?.trim();
  if (!key) return { state: "none" };
  const until = licenseDeactivationDate(key);
  if (until && until <= todayIso(now)) return { state: "expired", expiredOn: until };
  return { state: "valid", key, until };
}

/** The licence for /api/health: its state and date, never the key. */
export function licenseHealth(env: Record<string, string | undefined> = process.env, now = new Date()) {
  const license = agStudioLicense(env, now);
  if (license.state === "valid") return { state: "valid" as const, until: license.until };
  return license;
}

let warned = false;

/** One server warning per process when the key has expired, so the log says why the dashboard runs as a trial. */
export function warnIfExpired(license: AgStudioLicense, log: (message: string) => void = console.warn): void {
  if (license.state !== "expired" || warned) return;
  warned = true;
  log(
    `AG Studio: the key in AG_STUDIO_LICENSE_KEY deactivated on ${license.expiredOn}, so /shop/insights runs AG Studio as the keyless trial ("For Trial Use Only" watermark) until a new key is set.`,
  );
}

/** "November 28, 2026" */
export const licenseDateLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
