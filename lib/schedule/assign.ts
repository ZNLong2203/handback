import "server-only";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { rentalById, updateRental } from "@/lib/rentals/repo";
import { UserError, type Rental } from "@/lib/rentals/types";
import { occupantsForItem, unitsForItem } from "./repo";
import { earliestSlot, firstFreeUnit, spanLabel, type Occupant, type Span } from "./spans";

const spanOf = (r: Rental): Span => ({ start: r.startDate, end: r.endDate });

/** "Every Portable projector is booked for Oct 5–8. The earliest free dates for a rental this long are Oct 10–13." */
function fullyBookedMessage(rental: Rental, unitIds: string[], occupants: Occupant[]): string {
  const item = catalogItem(rental.itemId);
  const next = earliestSlot(unitIds, spanOf(rental), rental.startDate, occupants, rental.id);
  const hint = next ? ` The earliest free dates for a rental this long are ${spanLabel(next.span)}.` : " Please try other dates.";
  return `Every ${item.name} is booked for ${spanLabel(spanOf(rental))}.${hint}`;
}

/**
 * Gives a new booking the first unit of its item that is free for the whole
 * stay, counting slots held for a pending fix as taken. The item's units are
 * locked while choosing, so two people booking the last unit at the same
 * moment cannot both get it. When nothing is free the draft is removed and
 * the customer gets a message with the earliest dates that would work; no
 * PayPal order exists yet at this point.
 */
export async function assignUnitForBooking(rentalId: string, now = new Date()): Promise<string> {
  const db = await getDb();
  const outcome = await db.tx(async (tx) => {
    const rental = await rentalById(tx, rentalId);
    if (!rental) throw new UserError("That booking does not exist.");
    const units = await unitsForItem(tx, rental.itemId, true);
    // Slots the agent has set aside for a pending fix count as taken.
    const occupants = await occupantsForItem(tx, rental.itemId, now, true);
    const unitId = firstFreeUnit(
      units.map((u) => u.id),
      spanOf(rental),
      occupants,
      rental.id,
    );
    if (!unitId) return { unitId: null, message: fullyBookedMessage(rental, units.map((u) => u.id), occupants) };
    await updateRental(tx, rentalId, { unit_id: unitId });
    return { unitId, message: null };
  });
  if (!outcome.unitId) {
    await db.query("delete from rentals where id = $1 and status = 'draft'", [rentalId]);
    throw new UserError(outcome.message!);
  }
  return outcome.unitId;
}

/**
 * Runs just before the booking fee is captured. An unpaid draft only holds
 * its unit for a few minutes, so if the customer took longer in PayPal and
 * someone else booked that unit meanwhile, this moves the booking to another
 * free unit, or stops before any money moves.
 */
export async function confirmUnitBeforePayment(rentalId: string, now = new Date()): Promise<void> {
  const db = await getDb();
  await db.tx(async (tx) => {
    const rental = await rentalById(tx, rentalId);
    if (!rental) throw new UserError("That booking does not exist.");
    const units = await unitsForItem(tx, rental.itemId, true);
    const occupants = await occupantsForItem(tx, rental.itemId, now, true);
    const ids = units.map((u) => u.id);
    // Keep the unit it already has when that is still free.
    const order = rental.unitId ? [rental.unitId, ...ids.filter((id) => id !== rental.unitId)] : ids;
    const unitId = firstFreeUnit(order, spanOf(rental), occupants, rental.id);
    if (!unitId) {
      const item = catalogItem(rental.itemId);
      throw new UserError(`While you were in PayPal, the last ${item.name} for these dates was booked. Nothing was charged. Please pick other dates.`);
    }
    if (unitId !== rental.unitId) await updateRental(tx, rentalId, { unit_id: unitId });
  });
}
