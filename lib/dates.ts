const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written YYYY-MM-DD. Date.parse would quietly turn 2026-02-31 into March 3. */
export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** Whole days between pickup and return dates (YYYY-MM-DD); a same-day rental counts as one. */
export function rentalDays(startDate: string, endDate: string): number {
  if (!isIsoDay(startDate) || !isIsoDay(endDate)) throw new RangeError("dates must be real days, YYYY-MM-DD");
  const diff = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS;
  if (!Number.isInteger(diff) || diff < 0) throw new RangeError("the return date must be on or after the pickup date");
  return Math.max(1, diff);
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** "Oct 12" */
export function shortDate(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
