import "server-only";
import { CATALOG, catalogItem } from "@/lib/catalog";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { aiConfigured } from "@/lib/inspection/run";
import { paypalConfig } from "@/lib/paypal/config";
import { toRental } from "@/lib/rentals/repo";
import { STATUS } from "@/lib/rentals/status";
import type { Rental, RentalStatus } from "@/lib/rentals/types";
import { runScheduleAgent } from "./agent";
import * as repo from "./repo";
import { seedDemoSchedule } from "./seed";
import { displaySpan, holdSpan, overlaps, spanLabel, type Span } from "./spans";

// Everything the schedule page shows, as plain data the browser can take.
// Bryntum gets day strings; an event's endDate is exclusive there, so a
// rental that ends on Oct 8 is drawn up to the start of Oct 9.

export type MoneyState = "booked" | "held" | "review" | "settled" | "disputed";

export const MONEY_STATE: Record<RentalStatus, MoneyState | null> = {
  draft: null,
  cancelled: null,
  booked: "booked",
  out: "held",
  inspecting: "review",
  customer_review: "review",
  responded: "review",
  settled: "settled",
  disputed: "disputed",
};

export type ScheduleResource = {
  id: string;
  name: string;
  itemId: string;
  itemName: string;
  /** "Camera body": the unit label without its letter. */
  itemShort: string;
  category: string;
  /** Catalog order, so groups keep the shop's order rather than A to Z. */
  itemOrder: number;
  position: number;
  dailyCents: number;
  /** Where the unit is today. */
  status: "shelf" | "out" | "repair" | "blocked";
  /** "back Oct 4", "until Oct 7", or null on the shelf. */
  statusNote: string | null;
};

export type ScheduleEvent = {
  id: string;
  resourceId: string;
  name: string;
  startDate: string;
  endDate: string;
  start: string;
  end: string;
  itemId: string;
  itemName: string;
  unitLabel: string;
  money: MoneyState;
  statusLabel: string;
  feeCents: number;
  depositCents: number;
  heldCents: number | null;
  keptCents: number;
  releasedCents: number;
  /** Only bookings waiting for pickup, from today on, can be dragged to another unit. */
  draggable: boolean;
  resizable: boolean;
  /** What this booking clashes with on its unit, if anything. */
  conflict: string | null;
  proposalId: string | null;
  cls: string;
};

export type ScheduleBlock = {
  id: string;
  resourceId: string;
  name: string;
  startDate: string;
  endDate: string;
  start: string;
  end: string;
  kind: repo.BlockKind;
  reason: string;
  rentalId: string | null;
  cls: string;
};

export type ScheduleProposal = {
  id: string;
  kind: repo.ProposalKind;
  origin: repo.Proposal["origin"];
  status: repo.ProposalStatus;
  summary: string;
  message: string | null;
  messageSource: repo.Proposal["messageSource"];
  needsCall: boolean;
  rentalId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  itemName: string | null;
  fromUnit: string | null;
  toUnit: string | null;
  toUnitId: string | null;
  dates: string | null;
  newDates: string | null;
  /** Where the booking (or block) would go, both days included. */
  targetStart: string | null;
  targetEnd: string | null;
  cause: string | null;
  command: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type ScheduleView = {
  today: string;
  window: Span;
  resources: ScheduleResource[];
  events: ScheduleEvent[];
  blocks: ScheduleBlock[];
  pending: ScheduleProposal[];
  decided: ScheduleProposal[];
  ai: boolean;
  demo: boolean;
};

const DAYS_BEFORE = 7;
const DAYS_AFTER = 21;
const HOLDING: RentalStatus[] = ["booked", "out"];

function proposalView(p: repo.Proposal, rentals: Map<string, Rental>, labels: Map<string, string>, blocks: Map<string, repo.Block>): ScheduleProposal {
  const rental = p.rentalId ? rentals.get(p.rentalId) : undefined;
  const block = p.blockId ? blocks.get(p.blockId) : undefined;
  const span = rental ? { start: rental.startDate, end: rental.endDate } : null;
  const cause = block
    ? `${labels.get(block.unitId) ?? block.unitId} is ${block.kind === "repair" ? "in repair" : "blocked"} ${spanLabel({ start: block.startDate, end: block.endDate })}: ${block.reason}.`
    : p.cause?.startsWith("rental:")
      ? `Booked on the same unit as ${rentals.get(p.cause.slice(7))?.customerName ?? "another rental"}.`
      : null;
  return {
    id: p.id,
    kind: p.kind,
    origin: p.origin,
    status: p.status,
    summary: p.summary,
    message: p.message,
    messageSource: p.messageSource,
    needsCall: p.needsCall,
    rentalId: p.rentalId,
    customerName: rental?.customerName ?? null,
    customerEmail: rental?.customerEmail ?? null,
    itemName: rental ? catalogItem(rental.itemId).name : null,
    fromUnit: p.fromUnitId ? (labels.get(p.fromUnitId) ?? null) : null,
    toUnit: p.toUnitId ? (labels.get(p.toUnitId) ?? null) : null,
    toUnitId: p.toUnitId,
    dates: p.kind === "block" ? spanLabel({ start: p.startDate!, end: p.endDate! }) : span ? spanLabel(span) : null,
    newDates: p.kind === "reschedule" ? spanLabel({ start: p.startDate!, end: p.endDate! }) : null,
    targetStart: p.kind === "reassign" ? (span?.start ?? null) : p.startDate,
    targetEnd: p.kind === "reassign" ? (span?.end ?? null) : p.endDate,
    cause,
    command: p.command,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    decisionNote: p.decisionNote,
  };
}

export async function loadScheduleView(now = new Date()): Promise<ScheduleView> {
  const db = await getDb();
  const today = todayIso(now);
  const window = { start: addDaysIso(today, -DAYS_BEFORE), end: addDaysIso(today, DAYS_AFTER) };
  const units = await repo.listUnits(db);
  const labels = new Map(units.map((u) => [u.id, u.label]));

  const rows = await db.query<Record<string, unknown>>(
    `select * from rentals where status not in ('draft', 'cancelled') and unit_id is not null and end_date >= $1 and start_date <= $2
     order by start_date, id`,
    [window.start, window.end],
  );
  const rentals = rows.map(toRental);
  const returned = await repo.returnDays(
    db,
    rentals.filter((r) => !HOLDING.includes(r.status)).map((r) => r.id),
  );
  const blocks = await repo.listBlocks(db, addDaysIso(window.start, -60), window.end);
  const pendingRaw = await repo.listProposals(db, "pending");
  const decidedRaw = await repo.recentDecisions(db, 6);

  // Rentals the proposals talk about may sit outside the window; fetch them too.
  const byId = new Map(rentals.map((r) => [r.id, r]));
  const missing = [...pendingRaw, ...decidedRaw].map((p) => p.rentalId).filter((id): id is string => Boolean(id && !byId.has(id)));
  if (missing.length > 0) {
    const extra = await db.query<Record<string, unknown>>("select * from rentals where id = any($1)", [missing]);
    for (const r of extra.map(toRental)) byId.set(r.id, r);
  }
  const pendingFor = new Map(pendingRaw.filter((p) => p.rentalId).map((p) => [p.rentalId!, p.id]));
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const events: ScheduleEvent[] = [];
  for (const r of rentals) {
    const money = MONEY_STATE[r.status];
    const span = displaySpan(r, returned.get(r.id) ?? null);
    if (!money || !span || !r.unitId) continue;
    const hold = holdSpan(r, now);
    let conflict: string | null = null;
    if (hold) {
      const block = blocks.find((b) => b.unitId === r.unitId && overlaps(hold, { start: b.startDate, end: b.endDate }));
      const twin = rentals.find(
        (o) => o.id !== r.id && o.unitId === r.unitId && HOLDING.includes(o.status) && o.createdAt < r.createdAt && overlaps(hold, { start: o.startDate, end: o.endDate }),
      );
      if (block) conflict = `${labels.get(block.unitId)} is ${block.kind === "repair" ? "in repair" : "blocked"} ${spanLabel({ start: block.startDate, end: block.endDate })}.`;
      else if (twin) conflict = `${labels.get(r.unitId)} is also promised to ${twin.customerName}.`;
    }
    const item = catalogItem(r.itemId);
    events.push({
      id: r.id,
      resourceId: r.unitId,
      name: r.customerName,
      startDate: span.start,
      endDate: addDaysIso(span.end, 1),
      start: span.start,
      end: span.end,
      itemId: r.itemId,
      itemName: item.name,
      unitLabel: labels.get(r.unitId) ?? r.unitId,
      money,
      statusLabel: STATUS[r.status].label,
      feeCents: r.feeCents,
      depositCents: r.depositCents,
      heldCents: r.status === "settled" ? null : r.authorizedCents,
      keptCents: (r.capturedCents ?? 0) + (r.extraCents ?? 0),
      releasedCents: r.releasedCents ?? 0,
      draggable: r.status === "booked" && r.startDate >= today,
      resizable: false,
      conflict,
      proposalId: pendingFor.get(r.id) ?? null,
      cls: `hb-ev hb-ev-${money}${conflict ? " hb-ev-conflict" : ""}`,
    });
  }

  return {
    today,
    window,
    resources: units.map((u) => {
      const item = catalogItem(u.itemId);
      const block = blocks.find((b) => b.unitId === u.id && b.startDate <= today && b.endDate >= today);
      const out = rentals.find((r) => r.unitId === u.id && r.status === "out");
      const status = block ? (block.kind === "repair" ? "repair" : "blocked") : out ? "out" : "shelf";
      return {
        id: u.id,
        name: u.label,
        itemId: u.itemId,
        itemName: item.name,
        itemShort: u.label.replace(/\s+[A-Z]$/, ""),
        category: item.category,
        itemOrder: CATALOG.findIndex((i) => i.id === u.itemId),
        position: u.position,
        dailyCents: item.dailyCents,
        status,
        statusNote: block ? `until ${spanLabel({ start: block.endDate, end: block.endDate })}` : out ? `due ${spanLabel({ start: out.endDate, end: out.endDate })}` : null,
      } satisfies ScheduleResource;
    }),
    events,
    blocks: blocks
      .filter((b) => b.endDate >= window.start)
      .map((b) => ({
        id: b.id,
        resourceId: b.unitId,
        name: b.kind === "repair" ? `In repair · ${b.reason}` : `Blocked · ${b.reason}`,
        startDate: b.startDate,
        endDate: addDaysIso(b.endDate, 1),
        start: b.startDate,
        end: b.endDate,
        kind: b.kind,
        reason: b.reason,
        rentalId: b.rentalId,
        cls: `hb-block hb-block-${b.kind}`,
      })),
    pending: pendingRaw.map((p) => proposalView(p, byId, labels, blockById)),
    decided: decidedRaw.map((p) => proposalView(p, byId, labels, blockById)),
    ai: aiConfigured(),
    demo: paypalConfig().mode === "demo",
  };
}

/**
 * Before the page renders: in demo mode, two weeks of bookings the first
 * time; then one pass of the agent, so a settlement that happened while the
 * server was busy or restarting is never left unplanned.
 */
export async function prepareSchedule(now = new Date()): Promise<void> {
  await seedDemoSchedule(now);
  await runScheduleAgent(now);
}
