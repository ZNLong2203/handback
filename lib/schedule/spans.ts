import { addDaysIso } from "@/lib/dates";
import type { RentalStatus } from "@/lib/rentals/types";

// Pure date arithmetic for the schedule. Everything here works on whole days
// written as YYYY-MM-DD, with both ends of a span included, so a rental from
// Oct 5 to Oct 8 keeps its unit on Oct 5, 6, 7 and 8.

const DAY_MS = 86_400_000;

export type Span = { start: string; end: string };

export function overlaps(a: Span, b: Span): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Whole days from a to b; negative when b is earlier. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** The same number of days, starting on `start`. */
export function moveSpan(span: Span, start: string): Span {
  return { start, end: addDaysIso(start, dayDiff(span.start, span.end)) };
}

/** How long an unpaid booking keeps its unit while the customer is in PayPal. */
export const DRAFT_HOLD_MINUTES = 30;

export type RentalLike = { id: string; status: RentalStatus; startDate: string; endDate: string; createdAt: string };

/**
 * The days a rental keeps its unit from other customers. A paid booking, and
 * a rental that is out, hold it from the pickup day through the return day.
 * An unpaid draft holds it for a few minutes while the customer is in PayPal.
 * Once the item is back (inspecting onward) the rental holds nothing; if it
 * came back damaged, a repair block takes over.
 */
export function holdSpan(r: RentalLike, now: Date): Span | null {
  const span = { start: r.startDate, end: r.endDate };
  if (r.status === "booked" || r.status === "out") return span;
  if (r.status === "draft" && now.getTime() - Date.parse(r.createdAt) < DRAFT_HOLD_MINUTES * 60_000) return span;
  return null;
}

const RETURNED: RentalStatus[] = ["inspecting", "customer_review", "responded", "settled", "disputed"];

/** The days a rental is drawn on the timeline: the booked days, cut short when it came back early. */
export function displaySpan(r: RentalLike, returnedOn: string | null): Span | null {
  if (r.status === "draft" || r.status === "cancelled") return null;
  if (RETURNED.includes(r.status) && returnedOn && returnedOn >= r.startDate && returnedOn < r.endDate) {
    return { start: r.startDate, end: returnedOn };
  }
  return { start: r.startDate, end: r.endDate };
}

/** Something that keeps a unit busy: a rental, a block, or a pending proposal's target. */
export type Occupant = {
  kind: "rental" | "block" | "proposal";
  id: string;
  /** For a proposal: the rental it would move. A rental never clashes with its own proposal. */
  rentalId?: string;
  unitId: string;
  span: Span;
};

/** What stands in the way of putting `span` on `unitId`, leaving out the rental being placed. */
export function clashesOn(unitId: string, span: Span, occupants: Occupant[], placingRentalId?: string): Occupant[] {
  return occupants.filter(
    (o) =>
      o.unitId === unitId &&
      overlaps(o.span, span) &&
      !(placingRentalId && (o.id === placingRentalId || o.rentalId === placingRentalId)),
  );
}

/** The first unit, in the order given, that is free for the whole span. */
export function firstFreeUnit(unitIds: string[], span: Span, occupants: Occupant[], placingRentalId?: string): string | null {
  return unitIds.find((u) => clashesOn(u, span, occupants, placingRentalId).length === 0) ?? null;
}

/**
 * The earliest start on or after `from`, at most `horizonDays` later, at which
 * some unit is free for a span as long as `span`. Days are tried in order and
 * units in the order given, so the same schedule always gives the same answer.
 */
export function earliestSlot(
  unitIds: string[],
  span: Span,
  from: string,
  occupants: Occupant[],
  placingRentalId?: string,
  horizonDays = 60,
): { unitId: string; span: Span } | null {
  for (let i = 0; i <= horizonDays; i++) {
    const candidate = moveSpan(span, addDaysIso(from, i));
    const unitId = firstFreeUnit(unitIds, candidate, occupants, placingRentalId);
    if (unitId) return { unitId, span: candidate };
  }
  return null;
}
