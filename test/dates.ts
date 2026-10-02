import { addDaysIso, todayIso } from "@/lib/dates";

// The shop has two or three units of each item, so tests that book the same
// item many times give every booking its own dates instead of all asking for
// today. Each test file runs in its own worker, so the count is per file.
let week = 0;

/** A rental `nights` days long (at most 3) starting `from` days after the next free four-day slot. */
export function spacedDates(nights = 3, from = 0): { startDate: string; endDate: string } {
  if (nights > 3) throw new Error("spacedDates keeps rentals within a four-day slot");
  const startDate = addDaysIso(todayIso(), 4 * week++ + from);
  return { startDate, endDate: addDaysIso(startDate, nights) };
}
