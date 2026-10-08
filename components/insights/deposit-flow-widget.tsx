"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useRef, useState } from "react";
import { FLOW } from "@/lib/insights/model";
import type { DepositFlowWidget } from "@/lib/insights/registry";
import { layoutSankey, type LaidLink } from "@/lib/insights/sankey";
import { useSize, money } from "./widget-utils";

/**
 * "Where the deposits went": deposits held, flowing to what was released,
 * captured for repairs or still held, and what was captured on to refunds,
 * disputes or kept. AG Charts' Sankey series is Enterprise-only, so this is
 * drawn as SVG from lib/insights/sankey.ts.
 *
 * Cross-filter aware both ways: a click on a band filters the page to the
 * rentals on that flow (a multi-value selection on from and to), a click on a
 * box to everything that reached it; when another widget filters the page,
 * the part of each band that matches is drawn solid over a faint full band.
 */

const ORDER = [FLOW.held, FLOW.above, FLOW.released, FLOW.stillHeld, FLOW.kept, FLOW.refunded, FLOW.disputed, FLOW.openDispute, FLOW.keptForGood];

const TONE: Record<string, string> = {
  [FLOW.held]: "var(--hb-held)",
  [FLOW.above]: "var(--hb-charged)",
  [FLOW.released]: "var(--hb-released)",
  [FLOW.stillHeld]: "var(--hb-held)",
  [FLOW.kept]: "var(--hb-charged)",
  [FLOW.refunded]: "var(--hb-released)",
  [FLOW.disputed]: "var(--hb-note)",
  [FLOW.openDispute]: "var(--hb-note)",
  [FLOW.keptForGood]: "var(--hb-charged)",
};
const tone = (id: string) => TONE[id] ?? "var(--hb-brand)";

type Flow = { from: string; to: string; value: number };

const key = (f: { from: string; to: string }) => `${f.from}\u0000${f.to}`;

export default function DepositFlowWidget(params: AgWidgetParams<DepositFlowWidget>) {
  const { widgetApi, dataMapping } = params;
  const fromField = dataMapping.from?.at(0);
  const toField = dataMapping.to?.at(0);
  const valueField = dataMapping.value?.at(0);
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [highlight, setHighlight] = useState<Map<string, number> | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const loaded = useRef(false);
  const [box, ref] = useSize<HTMLDivElement>();
  const selections = widgetApi.getCrossFilterSelections();

  useEffect(() => {
    if (!fromField || !toField || !valueField) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    let cancelled = false;
    widgetApi.setDisplayState("loading", { prominent: !loaded.current });
    widgetApi
      .getData({ fields: [fromField, toField, valueField] })
      .then((response) => {
        if (cancelled) return;
        const read = (rows: Record<string, unknown>[]) =>
          rows.map((r) => ({ from: String(r[fromField.key] ?? ""), to: String(r[toField.key] ?? ""), value: Number(r[valueField.key] ?? 0) })).filter((f) => f.value > 0);
        const all = read(response.results.rows);
        loaded.current = all.length > 0;
        setFlows(all);
        setHighlight(response.crossFilter ? new Map(read(response.crossFilter.rows).map((f) => [key(f), f.value])) : null);
        widgetApi.setDisplayState(all.length ? "displayed" : "noData");
      })
      .catch(() => {
        if (!cancelled) widgetApi.setDisplayState("noData");
      });
    return () => {
      cancelled = true;
    };
    // `params` changes whenever Studio refreshes the widget (filters, cross filters, data).
  }, [params, widgetApi, fromField, toField, valueField]);

  const selected = useMemo(() => {
    const keys = new Set<string>();
    for (const s of selections ?? []) {
      if (s.type === "multiValue") for (const combo of s.values) keys.add(combo.map((v) => String(v.value)).join("\u0000"));
      if (s.type === "value") for (const v of s.values) keys.add(`node:${String(v)}`);
    }
    return keys;
  }, [selections]);

  // Room for the first column's labels on the left and the last column's on the right.
  const pad = { top: 8, bottom: 8, left: Math.min(140, Math.max(105, box.width * 0.15)), right: Math.min(185, Math.max(150, box.width * 0.22)) };
  const layout = useMemo(() => {
    if (!flows || box.width < 50 || box.height < 50) return null;
    return layoutSankey(flows, { width: Math.max(10, box.width - pad.left - pad.right), height: Math.max(10, box.height - pad.top - pad.bottom) }, { order: ORDER, nodeWidth: 12, gap: 16, minNodeHeight: 30 });
  }, [flows, box.width, box.height, pad.left, pad.right, pad.top, pad.bottom]);

  const toggleLink = (l: LaidLink, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fromField || !toField) return;
    widgetApi.toggleCrossFilter({
      type: "multiValue",
      values: [
        { field: fromField as AgWidgetField, value: l.from },
        { field: toField as AgWidgetField, value: l.to },
      ],
      group: 0,
      reset: !(e.metaKey || e.ctrlKey || e.shiftKey),
    });
  };
  const toggleNode = (id: string, depth: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const field = depth === 0 ? fromField : toField;
    if (!field) return;
    widgetApi.toggleCrossFilter({ type: "value", field: field as AgWidgetField, value: id, group: 1, reset: !(e.metaKey || e.ctrlKey || e.shiftKey) });
  };

  const fmt = (v: number) => (valueField ? widgetApi.formatFieldValue(valueField as AgWidgetField, v) : money(v));
  const anySelected = selected.size > 0;

  return (
    <div ref={ref} className="hb-widget h-full w-full" onClick={() => widgetApi.resetCrossFilter()} data-testid="deposit-flow">
      {layout && (
        <svg width={box.width} height={box.height} role="group" aria-label="Where the deposits went: flows from deposits held to released, captured, refunded, disputed and kept">
          <g transform={`translate(${pad.left},${pad.top})`}>
            {layout.links.map((l) => {
              const k = key(l);
              const part = highlight?.get(k);
              const isSel = selected.has(k) || selected.has(`node:${l.to}`) || selected.has(`node:${l.from}`);
              const faded = (anySelected && !isSel) || (highlight !== null && !part);
              const label = `${l.from} → ${l.to}: ${fmt(l.value)}${part !== undefined && highlight ? ` (${fmt(part)} in the filtered rows)` : ""}`;
              return (
                <g key={k}>
                  <path
                    d={l.path}
                    fill={tone(l.to)}
                    fillOpacity={faded ? 0.1 : hover === k ? 0.55 : 0.32}
                    stroke={tone(l.to)}
                    strokeOpacity={isSel ? 0.9 : 0}
                    className="hb-flow-band"
                    onClick={(e) => toggleLink(l, e)}
                    onMouseEnter={() => setHover(k)}
                    onMouseLeave={() => setHover(null)}
                    tabIndex={0}
                    role="button"
                    aria-label={label}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") toggleLink(l, e as unknown as React.MouseEvent);
                    }}
                  >
                    <title>{label}</title>
                  </path>
                  {highlight && part !== undefined && part > 0 && part < l.value && (
                    <path d={partialBand(l, part / l.value)} fill={tone(l.to)} fillOpacity={0.6} pointerEvents="none" />
                  )}
                </g>
              );
            })}
            {layout.nodes.map((n) => {
              const left = n.depth === 0;
              const tx = left ? n.x - 8 : n.x + 12 + 8;
              const anchor = left ? "end" : "start";
              const isSel = selected.has(`node:${n.id}`);
              return (
                <g key={n.id} className="hb-flow-node" onClick={(e) => toggleNode(n.id, n.depth, e)} role="button" aria-label={`${n.id}: ${fmt(n.value)}`}>
                  <rect x={n.x} y={n.y} width={12} height={Math.max(2, n.height)} rx={3} fill={tone(n.id)} stroke={isSel ? "var(--hb-ink)" : "none"} strokeWidth={1.5} />
                  <text x={tx} y={n.y + n.height / 2 - 7} className="hb-flow-label" dominantBaseline="middle" textAnchor={anchor}>
                    {n.id}
                  </text>
                  <text x={tx} y={n.y + n.height / 2 + 8} className="hb-flow-value" dominantBaseline="middle" textAnchor={anchor}>
                    {fmt(n.value)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

/** The top `share` of a band, drawn over it to show the cross-filtered part. */
function partialBand(l: LaidLink, share: number): string {
  const w = l.width * share;
  const mx = (l.x0 + l.x1) / 2;
  const r = (n: number) => Math.round(n * 100) / 100;
  return `M${r(l.x0)},${r(l.sy)} C${r(mx)},${r(l.sy)} ${r(mx)},${r(l.ty)} ${r(l.x1)},${r(l.ty)} L${r(l.x1)},${r(l.ty + w)} C${r(mx)},${r(l.ty + w)} ${r(mx)},${r(l.sy + w)} ${r(l.x0)},${r(l.sy + w)} Z`;
}
