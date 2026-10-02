import "server-only";
import { catalogItem } from "@/lib/catalog";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { appendEvent } from "@/lib/rentals/audit";
import { latestAssessment, rentalById, toRental } from "@/lib/rentals/repo";
import { isCharged } from "@/lib/rentals/settlement";
import type { Rental, ReviewedFinding } from "@/lib/rentals/types";
import { SHOP } from "@/lib/shop";
import { draftMessage, templateMessage, type MessageFacts } from "./messages";
import { repairDays } from "./repair-days";
import * as repo from "./repo";
import { clashesOn, displaySpan, earliestSlot, firstFreeUnit, spanLabel, type Occupant, type Span } from "./spans";

// The schedule agent. It never moves a booking by itself: it blocks a unit
// that came back damaged (a fact, from the settled charges), and for every
// booking that no longer fits it works out a fix and asks a person. Each run
// looks at the whole schedule and is safe to repeat, so it can run after
// every change and whenever the schedule opens.

const REPAIR_KINDS = new Set(["new_damage", "missing"]);
/** How far ahead the agent looks for other dates when no unit is free. */
export const SEARCH_DAYS = 60;

type Row = Record<string, unknown>;
const spanOf = (r: Rental): Span => ({ start: r.startDate, end: r.endDate });
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The repair a settled return needs: the longest repair among its charged damage and missing parts. */
export function repairNeeded(findings: ReviewedFinding[]): { days: number; reason: string; priceIds: string[] } | null {
  const repairs = findings.filter((f) => isCharged(f) && REPAIR_KINDS.has(f.kind) && f.price);
  if (repairs.length === 0) return null;
  return {
    days: Math.max(1, ...repairs.map((f) => repairDays(f.price!))),
    reason: [...new Set(repairs.map((f) => f.price!.label))].join(", "),
    priceIds: repairs.map((f) => f.price!.id),
  };
}

export type AgentRun = {
  unitsAssigned: string[];
  blocks: repo.Block[];
  superseded: string[];
  proposals: repo.Proposal[];
};

// ─── 1. Rentals booked before units existed ─────────────────

/** Gives each older rental without a unit the first unit it fits on, so the timeline can draw it. */
async function backfillUnits(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    "select * from rentals where unit_id is null and status not in ('draft', 'cancelled') order by start_date, created_at, id",
  );
  const done: string[] = [];
  for (const rental of rows.map(toRental)) {
    await db.tx(async (tx) => {
      const units = await repo.unitsForItem(tx, rental.itemId, true);
      if (units.length === 0) return;
      const placed = await tx.query<Row>("select * from rentals where unit_id = any($1) and status not in ('draft', 'cancelled')", [units.map((u) => u.id)]);
      const occupants: Occupant[] = placed.map(toRental).flatMap((r) => {
        const span = displaySpan(r, null);
        return span && r.unitId ? [{ kind: "rental" as const, id: r.id, unitId: r.unitId, span }] : [];
      });
      const span = displaySpan(rental, null) ?? spanOf(rental);
      const unitId = firstFreeUnit(units.map((u) => u.id), span, occupants, rental.id) ?? units[0].id;
      await tx.query("update rentals set unit_id = $2 where id = $1 and unit_id is null", [rental.id, unitId]);
    });
    done.push(rental.id);
  }
  return done;
}

// ─── 2. Repair blocks for damaged returns ───────────────────

async function createRepairBlocks(now: Date): Promise<repo.Block[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const rows = await db.query<Row>(
    `select r.* from rentals r
     where r.status in ('settled', 'disputed') and r.unit_id is not null and r.settled_at >= $1
       and not exists (select 1 from blocks b where b.rental_id = r.id and b.kind = 'repair')
     order by r.settled_at, r.id`,
    [since],
  );
  const created: repo.Block[] = [];
  for (const rental of rows.map(toRental)) {
    const assessment = await latestAssessment(db, rental.id);
    const need = assessment && repairNeeded(assessment.findings);
    if (!need) continue;
    const start = (rental.settledAt ?? now.toISOString()).slice(0, 10);
    const block = await db.tx(async (tx) => {
      const inserted = await repo.insertBlock(tx, {
        id: repo.newId("B"),
        unitId: rental.unitId!,
        startDate: start,
        endDate: addDaysIso(start, need.days - 1),
        kind: "repair",
        reason: need.reason,
        rentalId: rental.id,
        createdBy: "agent",
      });
      if (inserted) {
        await appendEvent(tx, rental.id, "system", "repair.blocked", {
          blockId: inserted.id,
          unitId: inserted.unitId,
          startDate: inserted.startDate,
          endDate: inserted.endDate,
          days: need.days,
          priceIds: need.priceIds,
        });
      }
      return inserted;
    });
    if (block) created.push(block);
  }
  return created;
}

// ─── 3. Pending proposals that no longer apply ──────────────

/** Why a pending proposal can no longer be approved as it stands, or null if it still can. */
export async function staleReason(p: repo.Proposal, now: Date): Promise<string | null> {
  const db = await getDb();
  const today = todayIso(now);
  if (p.kind === "block") {
    return p.startDate! < today ? "Those dates have passed." : null;
  }
  const rental = p.rentalId ? await rentalById(db, p.rentalId) : null;
  if (!rental || rental.status !== "booked") return "The booking is no longer waiting for pickup.";
  if (rental.startDate < today) return "The booking has started.";
  if (p.fromUnitId && rental.unitId !== p.fromUnitId) return "The booking has moved since.";
  const occupants = await repo.occupantsForItem(db, rental.itemId, now);
  if (p.origin === "agent" && p.cause && !causeStillClashes(p.cause, rental, occupants)) return "The clash is gone.";
  if (p.kind === "reassign" && clashesOn(p.toUnitId!, spanOf(rental), occupants, rental.id).length > 0) return "That unit is no longer free.";
  if (p.kind === "reschedule" && clashesOn(p.toUnitId!, { start: p.startDate!, end: p.endDate! }, occupants, rental.id).length > 0) {
    return "Those dates are no longer free.";
  }
  if (p.kind === "call") {
    // Ask what the agent asked when it made the call: slots set aside for other pending fixes are taken.
    // Leaving them out would retire the call for a slot nobody can offer, and the next run would make it again.
    const units = await repo.unitsForItem(db, rental.itemId);
    const reserved = await repo.occupantsForItem(db, rental.itemId, now, true);
    if (planFix(rental, units.map((u) => u.id), reserved).kind !== "call") return "A unit has come free.";
  }
  return null;
}

function causeStillClashes(cause: string, rental: Rental, occupants: Occupant[]): boolean {
  const [kind, id] = cause.split(":");
  return clashesOn(rental.unitId!, spanOf(rental), occupants, rental.id).some((o) => o.kind === kind && o.id === id);
}

async function reviewPending(now: Date): Promise<string[]> {
  const db = await getDb();
  const superseded: string[] = [];
  for (const p of await repo.listProposals(db, "pending")) {
    const reason = await staleReason(p, now);
    if (reason && (await repo.decideProposal(db, p.id, "superseded", reason))) superseded.push(p.id);
  }
  return superseded;
}

// ─── 4. Fixes for bookings that no longer fit ───────────────

/**
 * What a booking clashes with on its own unit: a block, or (only for data
 * from before units existed) another rental that was booked first.
 */
function clashCauses(rental: Rental, occupants: Occupant[], bookedFirst: (otherId: string) => boolean): Occupant[] {
  return clashesOn(rental.unitId!, spanOf(rental), occupants.filter((o) => o.kind !== "proposal"), rental.id)
    .filter((o) => o.kind === "block" || bookedFirst(o.id))
    .sort((a, b) => (a.kind === b.kind ? a.span.start.localeCompare(b.span.start) : a.kind === "block" ? -1 : 1));
}

async function proposeFixes(now: Date): Promise<repo.Proposal[]> {
  const db = await getDb();
  const today = todayIso(now);
  const rows = await db.query<Row>(
    "select * from rentals where status = 'booked' and unit_id is not null and start_date >= $1 order by start_date, created_at, id",
    [today],
  );
  const booked = rows.map(toRental);
  const created: repo.Proposal[] = [];
  const labels = new Map((await repo.listUnits(db)).map((u) => [u.id, u.label]));

  for (const itemId of [...new Set(booked.map((r) => r.itemId))]) {
    const units = (await repo.unitsForItem(db, itemId)).map((u) => u.id);
    const occupants = await repo.occupantsForItem(db, itemId, now, true);
    const active = new Map((await repo.activeRentalsForItem(db, itemId)).map((r) => [r.id, r]));

    for (const rental of booked.filter((r) => r.itemId === itemId)) {
      const bookedFirst = (otherId: string) => {
        const other = active.get(otherId);
        return Boolean(other && (other.createdAt < rental.createdAt || (other.createdAt === rental.createdAt && other.id < rental.id)));
      };
      const [cause] = clashCauses(rental, occupants, bookedFirst);
      if (!cause) continue;
      const causeKey = `${cause.kind}:${cause.id}`;
      if ((await repo.openOrRejected(db, rental.id, causeKey)).length > 0) continue;

      const block = cause.kind === "block" ? await repo.blockById(db, cause.id) : null;
      const plan = planFix(rental, units, occupants);
      const item = catalogItem(rental.itemId);
      const facts: MessageFacts = {
        shopName: SHOP.name,
        customerName: rental.customerName,
        itemName: item.name,
        kind: plan.kind,
        why: block ? (block.kind === "repair" ? "repair" : "maintenance") : "double-booked",
        booked: spanOf(rental),
        offered: plan.kind === "reschedule" ? plan.span : undefined,
      };
      const from = labels.get(rental.unitId!) ?? rental.unitId!;
      const to = plan.kind === "call" ? null : (labels.get(plan.unitId) ?? plan.unitId);
      const summary =
        plan.kind === "reassign"
          ? `Move ${rental.customerName} from ${from} to ${to}. Same dates (${spanLabel(spanOf(rental))}) and the same model, so nothing changes for the customer.`
          : plan.kind === "reschedule"
            ? `No ${item.name.toLowerCase()} is free for ${rental.customerName} on ${spanLabel(spanOf(rental))}. The earliest free dates are ${spanLabel(plan.span)} on ${to}. Call ${first(rental.customerName)} before approving.`
            : `No ${item.name.toLowerCase()} is free for ${rental.customerName} within ${SEARCH_DAYS} days of ${spanLabel(spanOf(rental))}. Call ${first(rental.customerName)} to rebook or cancel.`;

      const proposal = await db.tx(async (tx) => {
        const inserted = await repo.insertProposal(tx, {
          id: repo.newId("P"),
          kind: plan.kind,
          origin: "agent",
          rentalId: rental.id,
          cause: causeKey,
          blockId: block?.id ?? null,
          fromUnitId: rental.unitId!,
          toUnitId: plan.kind === "call" ? null : plan.unitId,
          startDate: plan.kind === "reschedule" ? plan.span.start : null,
          endDate: plan.kind === "reschedule" ? plan.span.end : null,
          blockKind: null,
          reason: null,
          needsCall: plan.kind !== "reassign",
          summary,
          message: templateMessage(facts),
          messageSource: "template",
          command: null,
        });
        if (inserted) {
          await appendEvent(tx, rental.id, "system", "schedule.proposed", {
            proposalId: inserted.id,
            kind: inserted.kind,
            cause: causeKey,
            toUnitId: inserted.toUnitId,
            startDate: inserted.startDate,
            endDate: inserted.endDate,
            needsCall: inserted.needsCall,
          });
        }
        return inserted;
      });
      if (!proposal) continue;
      created.push(proposal);
      // Reserve the slot, so the next booking in this run is not offered the same one.
      if (plan.kind !== "call") {
        occupants.push({ kind: "proposal", id: proposal.id, rentalId: rental.id, unitId: plan.unitId, span: plan.kind === "reschedule" ? plan.span : spanOf(rental) });
      }
    }
  }
  return created;
}

export type Fix = { kind: "reassign"; unitId: string } | { kind: "reschedule"; unitId: string; span: Span } | { kind: "call" };

/**
 * The deterministic search. Another unit of the same item on the same dates
 * if one is free (units in shelf order); otherwise the earliest later dates
 * on any unit, which a person has to agree with the customer; otherwise a call.
 */
export function planFix(rental: Rental, unitIds: string[], occupants: Occupant[]): Fix {
  const others = unitIds.filter((u) => u !== rental.unitId);
  const unitId = firstFreeUnit(others, spanOf(rental), occupants, rental.id);
  if (unitId) return { kind: "reassign", unitId };
  const slot = earliestSlot(unitIds, spanOf(rental), addDaysIso(rental.startDate, 1), occupants, rental.id, SEARCH_DAYS);
  return slot ? { kind: "reschedule", ...slot } : { kind: "call" };
}

// ─── The run ────────────────────────────────────────────────

const globalForAgent = globalThis as unknown as { handbackScheduleAgent?: Promise<unknown> };

/** One pass over the schedule. Runs one at a time per process; safe to call as often as you like. */
export function runScheduleAgent(now = new Date()): Promise<AgentRun> {
  const previous = globalForAgent.handbackScheduleAgent ?? Promise.resolve();
  const run = previous.then(async (): Promise<AgentRun> => {
    const unitsAssigned = await backfillUnits();
    const blocks = await createRepairBlocks(now);
    const superseded = await reviewPending(now);
    const proposals = await proposeFixes(now);
    const touched = new Set([...blocks.map((b) => b.rentalId!), ...proposals.map((p) => p.rentalId!)]);
    for (const id of touched) publish(id, "schedule.updated");
    if (touched.size === 0 && (superseded.length > 0 || unitsAssigned.length > 0)) publish("schedule", "schedule.updated");
    return { unitsAssigned, blocks, superseded, proposals };
  });
  globalForAgent.handbackScheduleAgent = run.catch(() => undefined);
  return run;
}

/**
 * Lets Gemini reword the customer message of pending proposals that still
 * carry the template. Slow and optional, so it runs after the response; a
 * draft that fails the checks leaves the template in place.
 */
export async function polishMessages(): Promise<number> {
  const db = await getDb();
  let polished = 0;
  for (const p of await repo.listProposals(db, "pending")) {
    if (p.messageSource !== "template" || !p.rentalId || p.kind === "block") continue;
    const rental = await rentalById(db, p.rentalId);
    if (!rental) continue;
    const block = p.blockId ? await repo.blockById(db, p.blockId) : null;
    const facts: MessageFacts = {
      shopName: SHOP.name,
      customerName: rental.customerName,
      itemName: catalogItem(rental.itemId).name,
      kind: p.kind as MessageFacts["kind"],
      why: block ? (block.kind === "repair" ? "repair" : "maintenance") : p.origin === "agent" ? "double-booked" : "staff",
      booked: spanOf(rental),
      offered: p.kind === "reschedule" ? { start: p.startDate!, end: p.endDate! } : undefined,
    };
    const drafted = await draftMessage(facts);
    if (drafted.source !== "gemini") continue;
    await repo.setProposalMessage(db, p.id, drafted.text, "gemini");
    publish(p.rentalId, "schedule.updated");
    polished++;
  }
  return polished;
}

/**
 * Called once a settlement has moved the money. A damaged return blocks its
 * unit and gets the affected bookings looked at straight away. It never
 * throws: the settlement stands whatever happens to the schedule, and the
 * next run of the agent catches up.
 */
export async function afterSettlement(rentalId: string): Promise<void> {
  try {
    await runScheduleAgent();
  } catch (err) {
    console.error(`schedule agent failed after settling ${rentalId}`, err);
  }
}
