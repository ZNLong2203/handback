// When the nightly demo reset is due. Plain JavaScript with no imports, so the
// cron job (renew-holds.mjs) runs it without a build; the web service imports
// the same functions (lib/demo-reset/config.ts), so the two never disagree on
// the hour.

/** 20:00 UTC: 3:00 in Vietnam, noon or 1 p.m. in California. */
export const DEFAULT_RESET_HOUR = 20;

/**
 * The reset hour in UTC from DEMO_RESET_HOUR: a whole number from 0 to 23.
 * Unset, empty or anything else gives the default; `valid` says which.
 *
 * @param {string | undefined} value
 * @returns {{ hour: number, valid: boolean }}
 */
export function parseResetHour(value) {
  const text = (value ?? "").trim();
  if (text === "") return { hour: DEFAULT_RESET_HOUR, valid: true };
  return /^\d{1,2}$/.test(text) && Number(text) <= 23 ? { hour: Number(text), valid: true } : { hour: DEFAULT_RESET_HOUR, valid: false };
}

/**
 * The hourly cron job asks for a reset on the run that falls in the reset hour.
 *
 * @param {Date} now
 * @param {number} hour
 */
export function resetDueAt(now, hour) {
  return now.getUTCHours() === hour;
}

/**
 * The day a reset belongs to, as YYYY-MM-DD. A reset day starts at the reset
 * hour, so a second call in the same 24 hours (the cron job retried, or someone
 * pressed Trigger Run) finds the day already done.
 *
 * @param {Date} now
 * @param {number} hour
 */
export function resetDayOf(now, hour) {
  return new Date(now.getTime() - hour * 3_600_000).toISOString().slice(0, 10);
}
