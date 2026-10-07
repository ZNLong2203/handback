import { addDaysIso, todayIso } from "@/lib/dates";
import { SHOP } from "@/lib/shop";

// The shop has two or three units of each item, so tests that book the same
// item many times give every booking its own dates instead of all asking for
// today. Each test file runs in its own worker, so the count is per file.
// Pickups can be booked at most SHOP.maxDaysAhead days out, so the slots
// start again from today once they reach that window: a slot is then
// shared, which every item's two or more units allow for a file's bookings.
let week = 0;
const SLOTS = Math.floor((SHOP.maxDaysAhead - 3) / 4) + 1;

/** A rental `nights` days long (at most 3) starting `from` days (at most 3) after the next four-day slot. */
export function spacedDates(nights = 3, from = 0): { startDate: string; endDate: string } {
  if (nights > 3) throw new Error("spacedDates keeps rentals within a four-day slot");
  const startDate = addDaysIso(todayIso(), 4 * (week++ % SLOTS) + from);
  return { startDate, endDate: addDaysIso(startDate, nights) };
}
