import "server-only";
import { randomBytes } from "node:crypto";
import { CATALOG } from "@/lib/catalog";
import type { Db } from "@/lib/db/client";
import { toRental } from "@/lib/rentals/repo";
import type { Rental } from "@/lib/rentals/types";
import { holdSpan, type Occupant } from "./spans";

type Query = Pick<Db, "query">;
type Row = Record<string, unknown>;

export type Unit = { id: string; itemId: string; label: string; position: number };

export type BlockKind = "repair" | "maintenance";
export type Block = {
  id: string;
  unitId: string;
  startDate: string;
  endDate: string;
  kind: BlockKind;
  reason: string;
  rentalId: string | null;
  createdBy: "agent" | "staff";
  createdAt: string;
};

/**
 * reassign: same dates, another unit of the same item.
 * reschedule: no unit is free on the booked dates; the earliest dates one is.
 * call: nothing is free within the search window; someone has to call.
 * block: take a unit out of service (from a typed command).
 */
export type ProposalKind = "reassign" | "reschedule" | "call" | "block";
export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

export type Proposal = {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  origin: "agent" | "command";
  rentalId: string | null;
  cause: string | null;
  blockId: string | null;
  fromUnitId: string | null;
  toUnitId: string | null;
  startDate: string | null;
  endDate: string | null;
  blockKind: BlockKind | null;
  reason: string | null;
  needsCall: boolean;
  summary: string;
  message: string | null;
  messageSource: "gemini" | "template" | null;
  command: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const newId = (prefix: string) => `${prefix}-${[...randomBytes(6)].map((b) => ID_ALPHABET[b % 32]).join("")}`;

const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const CATALOG_ORDER = new Map(CATALOG.map((item, i) => [item.id, i]));

function toUnit(r: Row): Unit {
  return { id: String(r.id), itemId: String(r.item_id), label: String(r.label), position: Number(r.position) };
}

function toBlock(r: Row): Block {
  return {
    id: String(r.id),
    unitId: String(r.unit_id),
    startDate: day(r.start_date)!,
    endDate: day(r.end_date)!,
    kind: r.kind as BlockKind,
    reason: String(r.reason),
    rentalId: (r.rental_id as string | null) ?? null,
    createdBy: r.created_by as Block["createdBy"],
    createdAt: iso(r.created_at)!,
  };
}

function toProposal(r: Row): Proposal {
  return {
    id: String(r.id),
    kind: r.kind as ProposalKind,
    status: r.status as ProposalStatus,
    origin: r.origin as Proposal["origin"],
    rentalId: (r.rental_id as string | null) ?? null,
    cause: (r.cause as string | null) ?? null,
    blockId: (r.block_id as string | null) ?? null,
    fromUnitId: (r.from_unit_id as string | null) ?? null,
    toUnitId: (r.to_unit_id as string | null) ?? null,
    startDate: day(r.start_date),
    endDate: day(r.end_date),
    blockKind: (r.block_kind as BlockKind | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    needsCall: Boolean(r.needs_call),
    summary: String(r.summary),
    message: (r.message as string | null) ?? null,
    messageSource: (r.message_source as Proposal["messageSource"]) ?? null,
    command: (r.command as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    decidedAt: iso(r.decided_at),
    decisionNote: (r.decision_note as string | null) ?? null,
  };
}

// ─── Units ──────────────────────────────────────────────────

/** Every unit, in catalog order and then by position. */
export async function listUnits(db: Query): Promise<Unit[]> {
  const rows = await db.query<Row>("select * from units");
  return rows
    .map(toUnit)
    .sort((a, b) => (CATALOG_ORDER.get(a.itemId) ?? 99) - (CATALOG_ORDER.get(b.itemId) ?? 99) || a.position - b.position);
}

/**
 * The units of one item, in position order. With `lock`, the rows stay locked
 * until the transaction ends, so two bookings for the same item are placed
 * one after the other and can never take the same unit.
 */
export async function unitsForItem(db: Query, itemId: string, lock = false): Promise<Unit[]> {
  const rows = await db.query<Row>(`select * from units where item_id = $1 order by position${lock ? " for update" : ""}`, [itemId]);
  return rows.map(toUnit);
}

export async function unitById(db: Query, id: string): Promise<Unit | null> {
  const rows = await db.query<Row>("select * from units where id = $1", [id]);
  return rows[0] ? toUnit(rows[0]) : null;
}

// ─── Rentals on the schedule ────────────────────────────────

/** SQL: the rental's item has not come back, that is, it has no return photo and no settlement. */
const NOT_BACK = "r.settled_at is null and not exists (select 1 from inspections i where i.rental_id = r.id and i.phase = 'checkin')";

/**
 * Rentals that may hold a unit of the item: drafts, bookings, rentals that
 * are out, and disputed rentals whose item has not come back (a dispute can
 * open while the customer still has the item).
 */
export async function activeRentalsForItem(db: Query, itemId: string): Promise<Rental[]> {
  const rows = await db.query<Row>(
    `select r.* from rentals r join units u on u.id = r.unit_id
     where u.item_id = $1 and (r.status in ('draft', 'booked', 'out') or (r.status = 'disputed' and ${NOT_BACK}))`,
    [itemId],
  );
  return rows.map(toRental);
}

/**
 * Rentals whose customer has one of these units right now: picked up (the
 * deposit was held) and not brought back yet, whatever the status says.
 */
export async function rentalsWithCustomer(db: Query, unitIds: string[]): Promise<Rental[]> {
  if (unitIds.length === 0) return [];
  const rows = await db.query<Row>(
    `select r.* from rentals r
     where r.unit_id = any($1) and (r.status = 'out' or (r.status = 'disputed' and r.authorization_id is not null)) and ${NOT_BACK}
     order by r.end_date, r.id`,
    [unitIds],
  );
  return rows.map(toRental);
}

export async function blocksForItem(db: Query, itemId: string): Promise<Block[]> {
  const rows = await db.query<Row>("select b.* from blocks b join units u on u.id = b.unit_id where u.item_id = $1", [itemId]);
  return rows.map(toBlock);
}

/**
 * Everything that keeps the item's units busy right now: rentals holding a
 * unit, blocks, and (optionally) the targets of pending proposals, which
 * are reserved so the agent never suggests the same free slot twice.
 */
export async function occupantsForItem(db: Query, itemId: string, now: Date, withProposals = false): Promise<Occupant[]> {
  const [rentals, blocks] = await Promise.all([activeRentalsForItem(db, itemId), blocksForItem(db, itemId)]);
  const occupants: Occupant[] = [];
  for (const r of rentals) {
    // activeRentalsForItem leaves out the rentals whose item is back.
    const span = holdSpan(r, now, null);
    if (span && r.unitId) occupants.push({ kind: "rental", id: r.id, unitId: r.unitId, span });
  }
  for (const b of blocks) occupants.push({ kind: "block", id: b.id, unitId: b.unitId, span: { start: b.startDate, end: b.endDate } });
  if (withProposals) {
    const rows = await db.query<Row>(
      `select p.* from schedule_proposals p join units u on u.id = p.to_unit_id
       where p.status = 'pending' and p.kind in ('reassign', 'reschedule') and u.item_id = $1`,
      [itemId],
    );
    for (const p of rows.map(toProposal)) {
      if (!p.toUnitId || !p.rentalId) continue;
      const rental = rentals.find((r) => r.id === p.rentalId);
      const span = p.kind === "reschedule" ? { start: p.startDate!, end: p.endDate! } : rental && { start: rental.startDate, end: rental.endDate };
      if (span) occupants.push({ kind: "proposal", id: p.id, rentalId: p.rentalId, unitId: p.toUnitId, span });
    }
  }
  return occupants;
}

/** When each returned rental came back: the day of its latest check-in photo. */
export async function returnDays(db: Query, rentalIds: string[]): Promise<Map<string, string>> {
  if (rentalIds.length === 0) return new Map();
  const rows = await db.query<{ rental_id: string; at: Date | string }>(
    "select rental_id, max(taken_at) as at from inspections where phase = 'checkin' and rental_id = any($1) group by rental_id",
    [rentalIds],
  );
  return new Map(rows.map((r) => [r.rental_id, iso(r.at)!.slice(0, 10)]));
}

// ─── Blocks ─────────────────────────────────────────────────

export async function listBlocks(db: Query, from: string, to: string): Promise<Block[]> {
  const rows = await db.query<Row>("select * from blocks where end_date >= $1 and start_date <= $2 order by start_date", [from, to]);
  return rows.map(toBlock);
}

export async function blockById(db: Query, id: string): Promise<Block | null> {
  const rows = await db.query<Row>("select * from blocks where id = $1", [id]);
  return rows[0] ? toBlock(rows[0]) : null;
}

export async function repairBlockFor(db: Query, rentalId: string): Promise<Block | null> {
  const rows = await db.query<Row>("select * from blocks where rental_id = $1 and kind = 'repair'", [rentalId]);
  return rows[0] ? toBlock(rows[0]) : null;
}

/** Inserts a block. A second repair block for the same return is ignored; returns null then. */
export async function insertBlock(db: Query, b: Omit<Block, "createdAt">): Promise<Block | null> {
  const rows = await db.query<Row>(
    `insert into blocks (id, unit_id, start_date, end_date, kind, reason, rental_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (rental_id) where kind = 'repair' do nothing
     returning *`,
    [b.id, b.unitId, b.startDate, b.endDate, b.kind, b.reason, b.rentalId, b.createdBy],
  );
  return rows[0] ? toBlock(rows[0]) : null;
}

// ─── Proposals ──────────────────────────────────────────────

export async function proposalById(db: Query, id: string): Promise<Proposal | null> {
  const rows = await db.query<Row>("select * from schedule_proposals where id = $1", [id]);
  return rows[0] ? toProposal(rows[0]) : null;
}

export async function listProposals(db: Query, status: ProposalStatus | ProposalStatus[]): Promise<Proposal[]> {
  const statuses = Array.isArray(status) ? status : [status];
  const rows = await db.query<Row>("select * from schedule_proposals where status = any($1) order by created_at, id", [statuses]);
  return rows.map(toProposal);
}

/** Recently decided proposals, newest first. */
export async function recentDecisions(db: Query, limit: number): Promise<Proposal[]> {
  const rows = await db.query<Row>("select * from schedule_proposals where status <> 'pending' order by decided_at desc nulls last limit $1", [limit]);
  return rows.map(toProposal);
}

/** Proposals already made for this rental and cause, pending or turned down. */
export async function openOrRejected(db: Query, rentalId: string, cause: string): Promise<Proposal[]> {
  const rows = await db.query<Row>(
    "select * from schedule_proposals where rental_id = $1 and cause = $2 and status in ('pending', 'rejected')",
    [rentalId, cause],
  );
  return rows.map(toProposal);
}

/** Inserts a pending proposal. A second pending one for the same conflict is ignored; returns null then. */
export async function insertProposal(
  db: Query,
  p: Omit<Proposal, "status" | "createdAt" | "decidedAt" | "decisionNote">,
): Promise<Proposal | null> {
  const rows = await db.query<Row>(
    `insert into schedule_proposals (id, kind, status, origin, rental_id, cause, block_id, from_unit_id, to_unit_id,
       start_date, end_date, block_kind, reason, needs_call, summary, message, message_source, command)
     values ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (rental_id, cause) where status = 'pending' do nothing
     returning *`,
    [
      p.id,
      p.kind,
      p.origin,
      p.rentalId,
      p.cause,
      p.blockId,
      p.fromUnitId,
      p.toUnitId,
      p.startDate,
      p.endDate,
      p.blockKind,
      p.reason,
      p.needsCall,
      p.summary,
      p.message,
      p.messageSource,
      p.command,
    ],
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

/** Records a decision on a pending proposal. Returns false if it was no longer pending. */
export async function decideProposal(db: Query, id: string, status: Exclude<ProposalStatus, "pending">, note: string | null): Promise<boolean> {
  const rows = await db.query<Row>(
    "update schedule_proposals set status = $2, decided_at = now(), decision_note = $3 where id = $1 and status = 'pending' returning id",
    [id, status, note],
  );
  return rows.length > 0;
}

export async function setProposalMessage(db: Query, id: string, message: string, source: "gemini" | "template"): Promise<void> {
  await db.query("update schedule_proposals set message = $2, message_source = $3 where id = $1", [id, message, source]);
}
