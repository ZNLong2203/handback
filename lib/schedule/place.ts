import "server-only";
import type { Db } from "@/lib/db/client";
import { toRental } from "@/lib/rentals/repo";
import { blocksForItem, occupantsForItem, returnDays, unitsForItem } from "./repo";
import { clashesOn, displaySpan, holdSpan, type Occupant, type Span } from "./spans";

type Query = Pick<Db, "query">;

/**
 * Placing a rental whose days are already decided, such as sample history
 * moved back in time. A booking only has to avoid what holds a unit
 * (occupantsForItem), but a rental placed in the past must also avoid what
 * the timeline draws there: rentals that came back, and repair blocks. Used
 * by the demo seeds, which book from today and then move rentals back.
 */

/** Everything drawn on the item's units: every rental that is not cancelled, as the timeline draws it, plus blocks and pending suggestions. */
export async function drawnOccupants(db: Query, itemId: string, now: Date, exceptRentalId?: string): Promise<Occupant[]> {
  const units = await unitsForItem(db, itemId);
  const rows = await db.query<Record<string, unknown>>("select * from rentals where unit_id = any($1) and status <> 'cancelled'", [units.map((u) => u.id)]);
  const rentals = rows.map(toRental).filter((r) => r.id !== exceptRentalId);
  const back = await returnDays(
    db,
    rentals.map((r) => r.id),
  );
  const out: Occupant[] = [];
  for (const r of rentals) {
    const span = r.status === "draft" ? holdSpan(r, now, null) : displaySpan(r, back.get(r.id) ?? null);
    if (span && r.unitId) out.push({ kind: "rental", id: r.id, unitId: r.unitId, span });
  }
  for (const b of await blocksForItem(db, itemId)) {
    if (b.rentalId !== exceptRentalId) out.push({ kind: "block", id: b.id, unitId: b.unitId, span: { start: b.startDate, end: b.endDate } });
  }
  const proposals = (await occupantsForItem(db, itemId, now, true)).filter((o) => o.kind === "proposal" && o.rentalId !== exceptRentalId);
  return [...out, ...proposals];
}

/**
 * The first unit of the item, `prefer` first, that is free of everything
 * drawn for each of `spans`, and of every booking or suggestion that holds
 * a unit for each of `whileHeld` (days a repair block will sit on the unit
 * from now on: another block there is no clash for a booking to resolve).
 * Null when none is.
 */
export async function freeUnitFor(
  db: Query,
  itemId: string,
  spans: Span[],
  opts: { now: Date; exceptRentalId?: string; prefer?: string | null; whileHeld?: Span[] },
): Promise<string | null> {
  const ids = (await unitsForItem(db, itemId)).map((u) => u.id);
  const order = opts.prefer && ids.includes(opts.prefer) ? [opts.prefer, ...ids.filter((id) => id !== opts.prefer)] : ids;
  const drawn = await drawnOccupants(db, itemId, opts.now, opts.exceptRentalId);
  const held = opts.whileHeld?.length
    ? (await occupantsForItem(db, itemId, opts.now, true)).filter((o) => o.kind !== "block" && o.id !== opts.exceptRentalId && o.rentalId !== opts.exceptRentalId)
    : [];
  return (
    order.find(
      (unitId) =>
        spans.every((s) => clashesOn(unitId, s, drawn, opts.exceptRentalId).length === 0) &&
        (opts.whileHeld ?? []).every((s) => clashesOn(unitId, s, held, opts.exceptRentalId).length === 0),
    ) ?? null
  );
}
