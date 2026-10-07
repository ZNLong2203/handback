import { addDaysIso } from "@/lib/dates";
import { HONOR_PERIOD_DAYS } from "@/lib/paypal/gateway";

const DAY_MS = 86_400_000;

/**
 * When to renew a deposit hold. PayPal allows one reauthorization, from 72
 * hours after the hold (measured in the sandbox: refused at 71.9 hours,
 * accepted at 72.3) to day 29, and a renewed hold gets a fresh 3-day honor
 * period but keeps the original expiry. Renewing on day 4 would waste the
 * honor period on a two-week rental, so the renewal waits for the day before
 * the item is due back, and never comes before day 4.
 *
 * Pure, so the renewal job (jobs.ts) and the owner's dashboard (lib/insights)
 * read the same schedule.
 */
export function renewalDueAt(authorizedAt: Date, endDate: string): Date {
  const earliest = new Date(authorizedAt.getTime() + HONOR_PERIOD_DAYS * DAY_MS);
  const dayBeforeReturn = new Date(`${addDaysIso(endDate, -1)}T00:00:00Z`);
  return dayBeforeReturn > earliest ? dayBeforeReturn : earliest;
}
