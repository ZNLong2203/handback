"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HoldClockWidget } from "@/lib/insights/registry";
import { toMs, useSize } from "./widget-utils";

/**
 * "Hold clock": every running deposit hold on PayPal's 29-day clock, each
 * row starting at its own first authorization. Facts from the sandbox
 * (docs/paypal-sandbox-notes.md): renewal is allowed from 72 hours, once, and
 * a renewed hold keeps the first one's expiry. The shaded start is the honor
 * period, the diamond is when the hourly job renews (the day before the item
 * is due back, never before 72 hours), a check marks a renewal that
 * happened, and the filled part is how much of the clock has run.
 *
 * Click a row to filter the page to that rental; when another widget filters
 * the page, rows outside it fade.
 */

const DAY = 86_400_000;
const LIFE = 29;
const TICKS = [0, 3, 7, 14, 21, 29];

type Hold = {
  id: string;
  label: string | null;
  heldAt: number;
  renewalDue: number | null;
  expiresAt: number;
  renewedAt: number | null;
  attention: string | null;
  amount: number | null;
};

export default function HoldClockWidget(params: AgWidgetParams<HoldClockWidget>) {
  const { widgetApi, dataMapping } = params;
  const m = {
    hold: dataMapping.hold?.at(0),
    label: dataMapping.label?.at(0),
    heldAt: dataMapping.heldAt?.at(0),
    renewalDue: dataMapping.renewalDue?.at(0),
    expiresAt: dataMapping.expiresAt?.at(0),
    renewedAt: dataMapping.renewedAt?.at(0),
    attention: dataMapping.attention?.at(0),
    amount: dataMapping.amount?.at(0),
  };
  const [holds, setHolds] = useState<Hold[] | null>(null);
  const [inFilter, setInFilter] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loaded = useRef(false);
  const [box, ref] = useSize<HTMLDivElement>();
  const selections = widgetApi.getCrossFilterSelections();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!m.hold || !m.heldAt || !m.expiresAt || !m.renewalDue) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const fields = [m.hold, m.label, m.heldAt, m.renewalDue, m.expiresAt, m.renewedAt, m.attention, m.amount].filter((x): x is NonNullable<typeof x> => Boolean(x));
    let cancelled = false;
    widgetApi.setDisplayState("loading", { prominent: !loaded.current });
    widgetApi
      .getData({ fields })
      .then((response) => {
        if (cancelled) return;
        const read = (row: Record<string, unknown>): Hold | null => {
          const heldAt = toMs(row[m.heldAt!.key]);
          const expiresAt = toMs(row[m.expiresAt!.key]);
          if (heldAt === null || expiresAt === null) return null;
          return {
            id: String(row[m.hold!.key]),
            label: m.label ? String(row[m.label.key] ?? "") || null : null,
            heldAt,
            renewalDue: toMs(row[m.renewalDue!.key]),
            expiresAt,
            renewedAt: m.renewedAt ? toMs(row[m.renewedAt.key]) : null,
            attention: m.attention ? ((row[m.attention.key] as string | null) ?? null) : null,
            amount: m.amount ? Number(row[m.amount.key] ?? 0) : null,
          };
        };
        const all = response.results.rows.map(read).filter((h): h is Hold => h !== null).sort((a, b) => a.expiresAt - b.expiresAt);
        loaded.current = all.length > 0;
        setHolds(all);
        setInFilter(response.crossFilter ? new Set(response.crossFilter.rows.map((r) => String(r[m.hold!.key]))) : null);
        widgetApi.setDisplayState(all.length ? "displayed" : "noData");
      })
      .catch(() => {
        if (!cancelled) widgetApi.setDisplayState("noData");
      });
    return () => {
      cancelled = true;
    };
    // `params` changes whenever Studio refreshes the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, widgetApi]);

  const selected = useMemo(() => {
    const ids = new Set<string>();
    for (const s of selections ?? []) if (s.type === "value") for (const v of s.values) ids.add(String(v));
    return ids;
  }, [selections]);

  const labelW = Math.min(220, Math.max(150, box.width * 0.24));
  const trackW = Math.max(60, box.width - labelW - 24);
  const x = (days: number) => labelW + (Math.max(0, Math.min(LIFE, days)) / LIFE) * trackW;
  const rowH = (h: Hold) => (h.attention ? 58 : 44);
  const tops = (holds ?? []).reduce<number[]>((acc, h, i) => [...acc, i === 0 ? 28 : acc[i - 1] + rowH(holds![i - 1])], []);
  const bottom = holds && holds.length ? tops[holds.length - 1] + rowH(holds[holds.length - 1]) : 28;

  const pick = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (!m.hold) return;
    widgetApi.toggleCrossFilter({ type: "value", field: m.hold as AgWidgetField, value: id, group: 0, reset: !(e.metaKey || e.ctrlKey || e.shiftKey) });
  };
  const fmtMoney = (v: number) => (m.amount ? widgetApi.formatFieldValue(m.amount as AgWidgetField, v) : `$${v.toFixed(2)}`);

  return (
    <div ref={ref} className="hb-widget hb-clock h-full w-full overflow-y-auto" onClick={() => widgetApi.resetCrossFilter()} data-testid="hold-clock">
      {holds && box.width > 0 && (
        <svg width={box.width} height={bottom + 30} role="img" aria-label={`Hold clock: ${holds.length} running deposit hold${holds.length === 1 ? "" : "s"}`}>
          {/* Day axis: the same 29 days for every hold, from its first authorization. */}
          <g className="hb-clock-axis">
            {TICKS.map((d) => (
              <g key={d}>
                <line x1={x(d)} x2={x(d)} y1={22} y2={bottom} />
                <text x={x(d)} y={14} textAnchor={d === 0 ? "start" : d === LIFE ? "end" : "middle"}>
                  {d === 0 ? "held" : d === 3 ? "72 h" : d === LIFE ? "day 29" : `day ${d}`}
                </text>
              </g>
            ))}
          </g>
          {holds.map((h, i) => {
            const y = tops[i];
            const age = (now - h.heldAt) / DAY;
            const end = (h.expiresAt - h.heldAt) / DAY;
            const due = h.renewalDue !== null ? (h.renewalDue - h.heldAt) / DAY : null;
            const renewed = h.renewedAt !== null ? (h.renewedAt - h.heldAt) / DAY : null;
            const faded = (inFilter !== null && !inFilter.has(h.id)) || (selected.size > 0 && !selected.has(h.id));
            const warn = Boolean(h.attention);
            const daysLeft = Math.floor((h.expiresAt - now) / DAY);
            const summary = `${h.label ?? h.id}, ${h.id}: held ${age.toFixed(1)} of ${LIFE} days, ${daysLeft >= 0 ? `${daysLeft} days left` : "expired"}${renewed !== null ? ", renewed" : due !== null ? `, renewal due on day ${due.toFixed(1)}` : ""}${h.attention ? `. ${h.attention}` : ""}`;
            return (
              <g
                key={h.id}
                className="hb-clock-row"
                opacity={faded ? 0.3 : 1}
                onClick={(e) => pick(h.id, e)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick(h.id, e)}
                tabIndex={0}
                role="button"
                aria-label={summary}
              >
                <title>{summary}</title>
                <rect x={0} y={y + 2} width={box.width} height={rowH(h) - 4} className="hb-clock-hit" rx={8} />
                <text x={8} y={y + 16} className="hb-clock-label">
                  {fit(h.label ?? h.id, labelW - 16)}
                </text>
                <text x={8} y={y + 32} className="hb-clock-sub">
                  {h.id}
                  {h.amount !== null ? ` · ${fmtMoney(h.amount)}` : ""}
                </text>
                {/* The whole 29 days, the honor period, and the part that has run. */}
                <rect x={x(0)} y={y + 14} width={x(end) - x(0)} height={12} rx={6} className="hb-clock-track" />
                <rect x={x(0)} y={y + 14} width={x(3) - x(0)} height={12} rx={6} className="hb-clock-honor" />
                <rect x={x(0)} y={y + 14} width={Math.max(0, x(Math.min(age, end)) - x(0))} height={12} rx={6} fill={warn ? "var(--hb-charged)" : "var(--hb-held)"} fillOpacity={0.85} />
                <line x1={x(Math.min(age, end))} x2={x(Math.min(age, end))} y1={y + 8} y2={y + 32} className="hb-clock-now" />
                {due !== null && renewed === null && (
                  <path d={diamond(x(due), y + 20, 6)} className="hb-clock-due">
                    <title>Renewal due</title>
                  </path>
                )}
                {renewed !== null && (
                  <g transform={`translate(${x(renewed)},${y + 20})`} className="hb-clock-renewed">
                    <circle r={7} />
                    <path d="M-3.5,0 L-1,2.5 L3.5,-2.5" fill="none" strokeWidth={1.8} />
                  </g>
                )}
                <line x1={x(end)} x2={x(end)} y1={y + 10} y2={y + 30} className="hb-clock-expiry" />
                {warn && (
                  <text x={x(0)} y={y + 44} className="hb-clock-warn">
                    {h.attention}
                  </text>
                )}
              </g>
            );
          })}
          <g className="hb-clock-legend" transform={`translate(${labelW},${bottom + 16})`}>
            <rect x={0} y={-6} width={18} height={8} rx={4} className="hb-clock-honor" />
            <text x={24} y={0}>72-hour honor period</text>
            <path d={diamond(170, -2, 5)} className="hb-clock-due" />
            <text x={180} y={0}>renewal due</text>
            <g transform="translate(272,-2)" className="hb-clock-renewed">
              <circle r={6} />
            </g>
            <text x={282} y={0}>renewed (keeps the day-29 expiry)</text>
          </g>
        </svg>
      )}
    </div>
  );
}

/** Cuts a label to the room it has (about 7 px a character at this size); the full text stays in the row's accessible name. */
const fit = (text: string, px: number) => {
  const max = Math.max(4, Math.floor(px / 7));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
