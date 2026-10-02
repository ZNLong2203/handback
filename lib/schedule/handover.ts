import "server-only";
import { shortDate, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import type { Rental } from "@/lib/rentals/types";
import * as repo from "./repo";
import { overlaps, spanLabel } from "./spans";

// Which physical unit the counter gives each customer. The schedule can move
// a booking to another unit, so the rental page and the rentals list name the
// unit, and warn when the one promised is not ready to go out.

export type Handover = { unitId: string; label: string; warning: string | null };

/**
 * The unit each rental is promised. For a booking waiting for pickup, also
 * what should stop the counter handing that unit over: a repair or
 * maintenance block on it between today (or the pickup day, if later) and
 * the return day, or another customer who still has it and is overdue or
 * due back after this pickup.
 */
export async function handovers(rentals: Rental[], now = new Date()): Promise<Map<string, Handover>> {
  const result = new Map<string, Handover>();
  const placed = rentals.filter((r) => r.unitId);
  if (placed.length === 0) return result;
  const db = await getDb();
  const today = todayIso(now);
  const labels = new Map((await repo.listUnits(db)).map((u) => [u.id, u.label]));
  const waiting = placed.filter((r) => r.status === "booked");
  const lastDay = waiting.reduce((last, r) => (r.endDate > last ? r.endDate : last), today);
  const [blocks, withCustomer] =
    waiting.length > 0 ? await Promise.all([repo.listBlocks(db, today, lastDay), repo.rentalsWithCustomer(db, [...new Set(waiting.map((r) => r.unitId!))])]) : [[], []];

  for (const r of placed) {
    const label = labels.get(r.unitId!) ?? r.unitId!;
    let warning: string | null = null;
    if (r.status === "booked") {
      const from = r.startDate > today ? r.startDate : today;
      const span = { start: from, end: r.endDate > from ? r.endDate : from };
      const block = blocks.find((b) => b.unitId === r.unitId && overlaps(span, { start: b.startDate, end: b.endDate }));
      const holder = withCustomer.find((o) => o.id !== r.id && o.unitId === r.unitId && (o.endDate < today || o.endDate >= r.startDate));
      if (block) {
        warning = `${label} is ${block.kind === "repair" ? "in repair" : "blocked"} ${spanLabel({ start: block.startDate, end: block.endDate })} (${block.reason}). Move this booking to another unit on the schedule before handing anything over.`;
      } else if (holder) {
        warning = `${label} is still out with ${holder.customerName}, due back ${shortDate(holder.endDate)}. If it is not back, move this booking on the schedule before handing anything over.`;
      }
    }
    result.set(r.id, { unitId: r.unitId!, label, warning });
  }
  return result;
}
