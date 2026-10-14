import { addDaysIso } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import type { MoneyState, ScheduleEvent, ScheduleResource, ScheduleView } from "./view";

/**
 * The schedule without Bryntum: one row per unit, grouped by item, for the
 * two weeks the timeline opens on (from two days before today). Bookings,
 * the agent's suggested places and repair blocks become bars on day
 * columns, both days included. Pure, so the browser can draw it whatever
 * happened to Bryntum (components/schedule/simple-schedule.tsx).
 */

export const SIMPLE_DAYS = 14;
/** The timeline opens two days before today (bryntum-timeline.tsx, visibleDate). */
export const DAYS_BEFORE_TODAY = 2;

export type SimpleBar = {
  id: string;
  kind: "booking" | "suggestion" | "block" | "proposed-block";
  /** Customer name, or the block's label. */
  label: string;
  /** The second line: where the money is, why the unit is out, or what the agent suggests. */
  note: string;
  start: string;
  end: string;
  /** Day columns, 0-based, clipped to the two weeks shown. */
  from: number;
  to: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Stacked lanes in a row, so two bars on the same days do not hide each other. Blocks sit behind, laneless. */
  lane: number;
  money: MoneyState | null;
  conflict: string | null;
  rentalId: string | null;
  proposalId: string | null;
  needsCall: boolean;
};

export type SimpleRow = { unit: ScheduleResource; bars: SimpleBar[]; lanes: number };
export type SimpleGroup = { itemId: string; itemName: string; itemShort: string; dailyCents: number; rows: SimpleRow[] };
export type SimpleSchedule = { days: string[]; today: string; groups: SimpleGroup[] };

/** Whole dollars when there are no cents, as on the timeline's bars. */
const usd = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : formatUsd(cents));

/** The line under a booking's name: the amount that matters at its stage, as the timeline says it. */
export function moneyLine(e: Pick<ScheduleEvent, "money" | "depositCents" | "heldCents" | "keptCents">): string {
  if (e.money === "booked") return `${usd(e.depositCents)} at pickup`;
  if (e.money === "held" || e.money === "review") return e.heldCents ? `${usd(e.heldCents)} held` : "held";
  if (e.money === "disputed") return "dispute";
  return e.keptCents > 0 ? `kept ${usd(e.keptCents)}` : "released";
}

const dayIndex = (first: string, day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);

export function simpleSchedule(view: ScheduleView, days = SIMPLE_DAYS): SimpleSchedule {
  const first = addDaysIso(view.today, -DAYS_BEFORE_TODAY);
  const last = addDaysIso(first, days - 1);
  const columns = Array.from({ length: days }, (_, i) => addDaysIso(first, i));
  const labels = new Map(view.resources.map((r) => [r.id, r.name]));
  const place = (start: string, end: string) => {
    if (end < first || start > last) return null;
    return { from: Math.max(0, dayIndex(first, start)), to: Math.min(days - 1, dayIndex(first, end)), clippedStart: start < first, clippedEnd: end > last };
  };

  const byUnit = new Map<string, SimpleBar[]>();
  const add = (unitId: string, bar: Omit<SimpleBar, "from" | "to" | "clippedStart" | "clippedEnd" | "lane">) => {
    const at = place(bar.start, bar.end);
    if (!at) return;
    byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), { ...bar, ...at, lane: 0 }]);
  };

  for (const e of view.events) {
    add(e.resourceId, {
      id: e.id,
      kind: "booking",
      label: e.name,
      note: moneyLine(e),
      start: e.start,
      end: e.end,
      money: e.money,
      conflict: e.conflict,
      rentalId: e.id,
      proposalId: e.proposalId,
      needsCall: false,
    });
  }
  for (const b of view.blocks) {
    add(b.resourceId, { id: b.id, kind: "block", label: b.name, note: b.reason, start: b.start, end: b.end, money: null, conflict: null, rentalId: b.rentalId, proposalId: null, needsCall: false });
  }
  for (const p of view.pending) {
    if (!p.toUnitId || !p.targetStart || !p.targetEnd) continue;
    if ((p.kind === "reassign" || p.kind === "reschedule") && p.rentalId) {
      add(p.toUnitId, {
        id: `ghost:${p.id}`,
        kind: "suggestion",
        label: `Suggested: ${p.customerName ?? "booking"}`,
        note: p.kind === "reassign" ? `move here from ${p.fromUnit ?? "its unit"}` : `earliest free dates · call ${p.customerName?.split(" ")[0] ?? "the customer"} first`,
        start: p.targetStart,
        end: p.targetEnd,
        money: null,
        conflict: null,
        rentalId: p.rentalId,
        proposalId: p.id,
        needsCall: p.needsCall,
      });
    } else if (p.kind === "block") {
      add(p.toUnitId, {
        id: `ghostblock:${p.id}`,
        kind: "proposed-block",
        label: "Proposed block",
        note: labels.get(p.toUnitId) ?? "",
        start: p.targetStart,
        end: p.targetEnd,
        money: null,
        conflict: null,
        rentalId: null,
        proposalId: p.id,
        needsCall: false,
      });
    }
  }

  const rows = view.resources.map((unit): SimpleRow => {
    const bars = (byUnit.get(unit.id) ?? []).sort((a, b) => a.from - b.from || a.to - b.to || a.id.localeCompare(b.id));
    // Bookings and suggestions take the first lane free on their days; blocks are drawn behind them.
    const ends: number[] = [];
    for (const bar of bars) {
      if (bar.kind === "block" || bar.kind === "proposed-block") continue;
      let lane = ends.findIndex((end) => end < bar.from);
      if (lane === -1) lane = ends.length;
      ends[lane] = bar.to;
      bar.lane = lane;
    }
    return { unit, bars, lanes: Math.max(1, ends.length) };
  });

  const groups: SimpleGroup[] = [];
  for (const row of [...rows].sort((a, b) => a.unit.itemOrder - b.unit.itemOrder || a.unit.position - b.unit.position)) {
    const group = groups.at(-1);
    if (group && group.itemId === row.unit.itemId) group.rows.push(row);
    else groups.push({ itemId: row.unit.itemId, itemName: row.unit.itemName, itemShort: row.unit.itemShort, dailyCents: row.unit.dailyCents, rows: [row] });
  }
  return { days: columns, today: view.today, groups };
}
