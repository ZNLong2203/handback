import "server-only";
import { catalogItem } from "@/lib/catalog";
import { shortDate, todayIso } from "@/lib/dates";
import { getDb, type Db } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { appendEvent } from "@/lib/rentals/audit";
import { rentalById, updateRental } from "@/lib/rentals/repo";
import { UserError, type Rental } from "@/lib/rentals/types";
import { runScheduleAgent, staleReason } from "./agent";
import { spanLabel } from "./assign";
import * as repo from "./repo";
import { clashesOn, dayDiff, type Occupant, type Span } from "./spans";

// Every change to the schedule goes through here, whoever asked for it: a
// drag on the timeline, an approved proposal, or a confirmed command. The
// checks are the same each time and run on the server inside a transaction
// that locks the item's units.

type Query = Pick<Db, "query">;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const spanOf = (r: Rental): Span => ({ start: r.startDate, end: r.endDate });

/** Longest block a person can put in from the schedule. */
export const MAX_BLOCK_DAYS = 30;

/** "Drone kit B is booked by Sam Rivera on Oct 6–9." */
async function describeClash(db: Query, unitLabel: string, o: Occupant): Promise<string> {
  if (o.kind === "block") {
    const block = await repo.blockById(db, o.id);
    return block?.kind === "repair"
      ? `${unitLabel} is in repair ${spanLabel(o.span)} (${block.reason}).`
      : `${unitLabel} is blocked ${spanLabel(o.span)}${block ? ` (${block.reason})` : ""}.`;
  }
  const other = await rentalById(db, o.rentalId ?? o.id);
  return `${unitLabel} is booked by ${other?.customerName ?? "another customer"} on ${spanLabel(o.span)}.`;
}

/**
 * Why `rental` cannot go to `target` for `span`, or null if it can. The
 * rules: same item, not picked up yet, not starting in the past, and nothing
 * else on that unit on any of those days.
 */
export function moveProblem(rental: Rental, target: repo.Unit, span: Span, today: string): string | null {
  const item = catalogItem(rental.itemId);
  if (target.itemId !== rental.itemId) return `${target.label} is not a ${item.name}. A booking can only move to another unit of the same item.`;
  if (rental.status === "out") return `${first(rental.customerName)} already has this unit; a rental can only move before pickup.`;
  if (rental.status !== "booked") return "Only bookings waiting for pickup can move.";
  if (span.start < today) return `This booking starts ${shortDate(span.start)}, which has passed. Only future bookings can move.`;
  if (dayDiff(span.start, span.end) !== dayDiff(rental.startDate, rental.endDate)) return "A move keeps the length of the rental the same.";
  return null;
}

/** All the move rules, against what is on the schedule now. Null when the move is fine. */
export async function moveCheck(db: Query, rental: Rental, target: repo.Unit, span: Span, now: Date): Promise<string | null> {
  const problem = moveProblem(rental, target, span, todayIso(now));
  if (problem) return problem;
  const occupants = await repo.occupantsForItem(db, rental.itemId, now);
  const [clash] = clashesOn(target.id, span, occupants, rental.id);
  return clash ? describeClash(db, target.label, clash) : null;
}

async function checkedMove(tx: Query, rental: Rental, target: repo.Unit, span: Span, now: Date): Promise<void> {
  await repo.unitsForItem(tx, rental.itemId, true);
  const problem = await moveCheck(tx, rental, target, span, now);
  if (problem) throw new UserError(problem);
}

/** A drag on the timeline: same dates, another unit of the same item. */
export async function moveRentalToUnit(rentalId: string, unitId: string, now = new Date()): Promise<{ moved: boolean }> {
  const db = await getDb();
  const moved = await db.tx(async (tx) => {
    const rental = await rentalById(tx, rentalId);
    if (!rental) throw new UserError("That booking does not exist.");
    const target = await repo.unitById(tx, unitId);
    if (!target) throw new UserError("That unit does not exist.");
    if (rental.unitId === unitId) return false;
    await checkedMove(tx, rental, target, spanOf(rental), now);
    await updateRental(tx, rental.id, { unit_id: target.id });
    await appendEvent(tx, rental.id, "staff", "schedule.moved", { from: rental.unitId ?? null, to: target.id, via: "drag" });
    return true;
  });
  if (moved) {
    publish(rentalId, "schedule.moved");
    await runScheduleAgent(now);
  }
  return { moved };
}

/** Approving a proposal applies exactly what it says, after the same checks a drag gets. */
export async function approveProposal(id: string, now = new Date()): Promise<void> {
  const db = await getDb();
  const p = await repo.proposalById(db, id);
  if (!p) throw new UserError("That suggestion does not exist.");
  if (p.status !== "pending") throw new UserError("This suggestion has already been decided.");
  if (p.kind === "call") throw new UserError("There is nothing to apply: call the customer, then mark it handled.");
  const stale = await staleReason(p, now);
  if (stale) {
    await repo.decideProposal(db, p.id, "superseded", stale);
    await runScheduleAgent(now);
    throw new UserError(`This suggestion is out of date: ${stale} The agent has looked again.`);
  }

  if (p.kind === "block") {
    await db.tx(async (tx) => {
      const unit = await repo.unitById(tx, p.toUnitId!);
      if (!unit) throw new UserError("That unit does not exist.");
      const problem = blockProblem({ start: p.startDate!, end: p.endDate! }, todayIso(now));
      if (problem) throw new UserError(problem);
      await repo.unitsForItem(tx, unit.itemId, true);
      await repo.insertBlock(tx, {
        id: repo.newId("B"),
        unitId: unit.id,
        startDate: p.startDate!,
        endDate: p.endDate!,
        kind: p.blockKind ?? "maintenance",
        reason: p.reason ?? "Maintenance",
        rentalId: null,
        createdBy: "staff",
      });
      if (!(await repo.decideProposal(tx, p.id, "approved", null))) throw new UserError("This suggestion has already been decided.");
    });
    publish("schedule", "schedule.blocked");
    await runScheduleAgent(now);
    return;
  }

  await db.tx(async (tx) => {
    const rental = await rentalById(tx, p.rentalId!);
    if (!rental) throw new UserError("That booking does not exist.");
    const target = await repo.unitById(tx, p.toUnitId!);
    if (!target) throw new UserError("That unit does not exist.");
    const span = p.kind === "reschedule" ? { start: p.startDate!, end: p.endDate! } : spanOf(rental);
    await checkedMove(tx, rental, target, span, now);
    if (p.kind === "reschedule") {
      await updateRental(tx, rental.id, { unit_id: target.id, start_date: span.start, end_date: span.end });
      await appendEvent(tx, rental.id, "staff", "schedule.rescheduled", {
        proposalId: p.id,
        from: { unitId: rental.unitId ?? null, startDate: rental.startDate, endDate: rental.endDate },
        to: { unitId: target.id, startDate: span.start, endDate: span.end },
      });
    } else {
      await updateRental(tx, rental.id, { unit_id: target.id });
      await appendEvent(tx, rental.id, "staff", "schedule.moved", { from: rental.unitId ?? null, to: target.id, via: p.origin, proposalId: p.id });
    }
    if (!(await repo.decideProposal(tx, p.id, "approved", null))) throw new UserError("This suggestion has already been decided.");
  });
  publish(p.rentalId!, p.kind === "reschedule" ? "schedule.rescheduled" : "schedule.moved");
  await runScheduleAgent(now);
}

/** Turning a proposal down. The agent will not suggest the same fix for the same clash again. */
export async function rejectProposal(id: string, note?: string): Promise<void> {
  const db = await getDb();
  const p = await repo.proposalById(db, id);
  if (!p) throw new UserError("That suggestion does not exist.");
  const decision = note?.trim() || (p.kind === "call" ? "Handled by phone" : "Turned down at the counter");
  await db.tx(async (tx) => {
    if (!(await repo.decideProposal(tx, p.id, "rejected", decision))) throw new UserError("This suggestion has already been decided.");
    if (p.rentalId) await appendEvent(tx, p.rentalId, "staff", "schedule.rejected", { proposalId: p.id, kind: p.kind, note: decision });
  });
  publish(p.rentalId ?? "schedule", "schedule.rejected");
}

/** Why a block over `span` cannot be added, or null. */
export function blockProblem(span: Span, today: string): string | null {
  if (span.end < span.start) return "A block has to end on or after the day it starts.";
  if (span.start < today) return "A block cannot start in the past.";
  if (dayDiff(span.start, span.end) + 1 > MAX_BLOCK_DAYS) return `A block can be at most ${MAX_BLOCK_DAYS} days.`;
  return null;
}
