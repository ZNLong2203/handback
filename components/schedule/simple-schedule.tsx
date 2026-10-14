"use client";

import { CalendarRange, RotateCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import type { LoadFailure } from "@/components/load-guard";
import { cx } from "@/components/ui";
import { simpleSchedule, type SimpleBar } from "@/lib/schedule/simple";
import { spanLabel } from "@/lib/schedule/spans";
import type { ScheduleView } from "@/lib/schedule/view";

/**
 * The schedule without Bryntum: rows per unit, grouped by item, with the
 * bookings, the agent's suggested places and the repair blocks for the two
 * weeks the timeline opens on, as a CSS grid. Shown when Bryntum throws, its
 * code does not load, it has not drawn within the deadline, or its trial
 * refuses to run in this browser (schedule-board.tsx), and on a server with
 * SCHEDULE_FORCE_SIMPLE_VIEW=1, which is for tests. The suggestions panel
 * beside it keeps working: approving and turning down are server actions.
 */

const WHY: Record<LoadFailure["reason"], string> = {
  timeout: "It had not finished drawing after 15 seconds.",
  error: "It stopped with an error in this browser.",
  refused: "Bryntum's 45-day trial has expired in this browser, so it refused to draw the timeline.",
  forced: "This server sets SCHEDULE_FORCE_SIMPLE_VIEW, a switch for tests.",
};

const MONEY_BAR = {
  booked: "border-l-4 border-brand bg-brand-soft",
  held: "border-l-4 border-held bg-held-soft",
  review: "border-l-4 border-charged bg-[repeating-linear-gradient(135deg,var(--color-held-soft)_0_6px,var(--color-charged-soft)_6px_12px)]",
  settled: "border-l-4 border-released bg-released-soft",
  disputed: "border-l-4 border-charged bg-charged-soft",
} as const;

const LANE = 40;
/** Room under the bars for a block's label, so a bar over the block's first days does not hide it. */
const BLOCK_LABEL = 16;

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const unitNote = (status: string, note: string | null) =>
  status === "shelf" ? "on the shelf" : `${status === "out" ? "out" : status === "repair" ? "in repair" : "blocked"} ${note ?? ""}`.trim();

function barTitle(bar: SimpleBar): string {
  const when = spanLabel({ start: bar.start, end: bar.end });
  if (bar.kind === "suggestion") return `${bar.label}, ${when}: ${bar.note}. Nothing moves until someone approves it in the panel.`;
  if (bar.kind === "block" || bar.kind === "proposed-block") return `${bar.label}, ${when}`;
  return `${bar.label}, ${when}: ${bar.note}${bar.conflict ? `. ${bar.conflict}` : ""}. Open the rental.`;
}

function Bar({ bar, days, focused }: { bar: SimpleBar; days: number; focused: boolean }) {
  const left = `${(bar.from / days) * 100}%`;
  const width = `calc(${((bar.to - bar.from + 1) / days) * 100}% - 4px)`;
  const base = { left: `calc(${left} + 2px)`, width };
  const ends = cx(bar.clippedStart && "rounded-l-none", bar.clippedEnd && "rounded-r-none");
  const text = (
    <>
      <span className="block truncate font-semibold">
        {bar.clippedStart ? "← " : ""}
        {bar.label}
      </span>
      <span className="block truncate text-[11px] text-ink-soft">
        {bar.note}
        {bar.clippedEnd ? " →" : ""}
      </span>
    </>
  );
  const common = {
    title: barTitle(bar),
    "data-testid": "simple-bar",
    "data-kind": bar.kind,
    "data-bar-id": bar.id,
  };

  if (bar.kind === "block" || bar.kind === "proposed-block") {
    return (
      <div
        {...common}
        className={cx(
          "absolute inset-y-1 overflow-hidden rounded-lg text-[11px] font-medium text-charged",
          bar.kind === "block"
            ? "bg-[repeating-linear-gradient(135deg,var(--color-charged-soft)_0_6px,white_6px_12px)] ring-1 ring-charged/30"
            : "border-[1.5px] border-dashed border-charged/60 bg-charged-soft/40",
          ends,
        )}
        style={base}
      >
        <span className="absolute inset-x-2 bottom-0 truncate">{bar.label}</span>
      </div>
    );
  }
  const style = { ...base, top: 6 + bar.lane * LANE, height: LANE - 4 };
  if (bar.kind === "suggestion") {
    return (
      <div
        {...common}
        className={cx(
          "absolute z-10 overflow-hidden rounded-lg border-[1.5px] border-dashed bg-brand-soft/60 px-2 py-0.5 text-xs text-ink",
          bar.needsCall ? "border-held" : "border-brand",
          focused && "ring-2 ring-brand",
          ends,
        )}
        style={style}
      >
        {text}
      </div>
    );
  }
  return (
    <Link
      {...common}
      href={`/shop/rentals/${bar.rentalId}`}
      className={cx(
        "absolute z-10 overflow-hidden rounded-lg px-2 py-0.5 text-xs text-ink shadow-sm hover:brightness-95",
        MONEY_BAR[bar.money ?? "booked"],
        bar.conflict && "ring-2 ring-charged",
        focused && "ring-2 ring-brand",
        ends,
      )}
      style={style}
    >
      {text}
    </Link>
  );
}

export function SimpleSchedule({ view, failure, focus, onRetry }: { view: ScheduleView; failure: LoadFailure; focus: string | null; onRetry: () => void }) {
  const layout = useMemo(() => simpleSchedule(view), [view]);
  const days = layout.days.length;
  const todayAt = layout.days.indexOf(layout.today);
  const grid = { gridTemplateColumns: `11rem repeat(${days}, minmax(3.25rem, 1fr))` };
  const range = spanLabel({ start: layout.days[0], end: layout.days[days - 1] });

  return (
    <div className="space-y-3" data-testid="schedule-simple-view">
      <div role="status" className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-card)] border border-held/40 bg-held-soft px-4 py-3 text-sm">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-held" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">Simple schedule: the Bryntum timeline did not load</p>
            <p className="text-ink-soft">
              {WHY[failure.reason]} Below are the same bookings, repair blocks and suggestions for {range}, without dragging. The suggestions beside it still
              work: approving or turning one down runs on the server. To move a booking, approve a suggestion or tell the schedule above.
            </p>
            {failure.detail && failure.reason === "error" && <p className="break-all font-mono text-xs text-muted">{failure.detail}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-1.5 font-medium hover:border-ink/40"
        >
          <RotateCw className="h-4 w-4" aria-hidden /> Try the timeline again
        </button>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-card">
        <div className="min-w-[900px]" role="group" aria-label={`Units and bookings, ${range}`}>
          <div className="grid border-b border-line bg-paper text-xs text-muted" style={grid}>
            <div className="flex items-center gap-1.5 px-3 py-2 font-semibold text-ink">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden /> Unit
            </div>
            {layout.days.map((d, i) => (
              <div key={d} className={cx("border-l border-line px-1 py-2 text-center", i === todayAt && "bg-brand-soft font-semibold text-brand-ink")}>
                {weekday(d)} {Number(d.slice(8, 10))}
                {i === todayAt && <span className="block text-[10px] uppercase tracking-wide">today</span>}
              </div>
            ))}
          </div>

          {layout.groups.map((g) => (
            <div key={g.itemId}>
              <div className="border-b border-line bg-paper/70 px-3 py-1.5 text-xs">
                <span className="font-semibold text-ink">
                  {g.itemShort}
                </span>
                <span className="text-muted">
                  {" "}
                  · {g.rows.length} units · ${(g.dailyCents / 100).toLocaleString("en-US")} a day
                </span>
              </div>
              {g.rows.map((row) => (
                <div key={row.unit.id} className="grid border-b border-line last:border-b-0" style={grid} data-testid="simple-unit-row" data-unit-id={row.unit.id}>
                  <div className="px-3 py-2">
                    <p className="text-sm font-semibold">{row.unit.name}</p>
                    <p className={cx("text-[11px]", row.unit.status === "repair" || row.unit.status === "blocked" ? "text-charged" : "text-muted")}>
                      {unitNote(row.unit.status, row.unit.statusNote)}
                    </p>
                  </div>
                  <div
                    className="relative"
                    style={{ gridColumn: `2 / span ${days}`, minHeight: 12 + row.lanes * LANE + (row.bars.some((b) => b.kind === "block" || b.kind === "proposed-block") ? BLOCK_LABEL : 0) }}
                  >
                    {/* Day lines and today, behind the bars. */}
                    <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }} aria-hidden>
                      {layout.days.map((d, i) => (
                        <div key={d} className={cx("border-l border-line/70", i === todayAt && "bg-brand-soft/50")} />
                      ))}
                    </div>
                    {row.bars.map((bar) => (
                      <Bar key={bar.id} bar={bar} days={days} focused={focus === bar.id} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
