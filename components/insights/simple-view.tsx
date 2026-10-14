"use client";

import "./insights.css";
import { Bot, RotateCw, TriangleAlert } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { LoadFailure } from "@/components/load-guard";
import { cx } from "@/components/ui";
import { formatUsd } from "@/lib/money";
import { simpleViewData, utcMoment, type SimpleKpis } from "@/lib/insights/simple-view";
import type { StudioDataSpec } from "@/lib/insights/studio-data";
import { DepositFlowChart } from "./deposit-flow-widget";
import { HoldClockChart } from "./hold-clock-widget";

/**
 * The dashboard without AG Studio: the Overview's KPIs, the two custom
 * widgets (Handback's own SVG, drawn here outside Studio) and the ledger,
 * from the data the page already loaded. Shown when AG Studio throws, its
 * code does not load, or it has not drawn within the deadline
 * (insights-board.tsx), and on a server with INSIGHTS_FORCE_SIMPLE_VIEW=1,
 * which is for tests. It says so, offers to try AG Studio again, and says
 * the deposit desk is unavailable, because its chat runs inside AG Studio.
 */

const WHY: Record<LoadFailure["reason"], string> = {
  timeout: "It had not finished drawing after 15 seconds.",
  error: "It stopped with an error in this browser.",
  refused: "It refused to run in this browser.",
  forced: "This server sets INSIGHTS_FORCE_SIMPLE_VIEW, a switch for tests.",
};

function Panel({ title, subtitle, children, className }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-[18px] border border-[var(--hb-line)] bg-[var(--hb-card)] p-4", className)}>
      <h3 className="font-display text-[15px] font-bold text-[var(--hb-ink)]">{title}</h3>
      {subtitle && <p className="mt-0.5 text-xs text-[var(--hb-muted)]">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Kpi({ title, value, subtitle, color }: { title: string; value: string; subtitle: string; color: string }) {
  return (
    <div className="rounded-[18px] border border-[var(--hb-line)] bg-[var(--hb-card)] p-4" data-testid="simple-kpi">
      <p className="font-display text-[15px] font-bold text-[var(--hb-ink)]">{title}</p>
      <p className="text-xs text-[var(--hb-muted)]">{subtitle}</p>
      <p className="tabular mt-3 font-display text-3xl font-bold" style={{ color }} data-testid="simple-kpi-value">
        {value}
      </p>
    </div>
  );
}

export function SimpleView({
  spec,
  kpis,
  month,
  failure,
  dark,
  onRetry,
}: {
  spec: StudioDataSpec;
  kpis: SimpleKpis;
  month: string;
  failure: LoadFailure;
  dark: boolean;
  onRetry: () => void;
}) {
  const { flows, holds, ledger } = useMemo(() => simpleViewData(spec), [spec]);
  const net = ledger.reduce((s, l) => s + l.netCents, 0);
  const share = kpis.pickupsPhotographedShare;
  const clockHeight = Math.min(640, 90 + holds.reduce((h, x) => h + (x.attention ? 58 : 44), 0));

  return (
    <div className="hb-insights space-y-4 text-[var(--hb-ink)]" data-hb-mode={dark ? "dark" : "light"} data-testid="insights-simple-view">
      <div role="status" className="flex flex-wrap items-start justify-between gap-3 rounded-[18px] border border-[var(--hb-held)]/40 bg-[var(--hb-held-soft)] px-4 py-3 text-sm">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--hb-held)]" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">Simple view: the AG Studio dashboard did not load</p>
            <p className="text-[var(--hb-muted)]">
              {WHY[failure.reason]} These are the same figures from the same data, drawn without AG Studio: no filters, other pages or edit mode.
            </p>
            {failure.detail && failure.reason === "error" && <p className="break-all font-mono text-xs text-[var(--hb-muted)]">{failure.detail}</p>}
            <p className="flex items-center gap-1.5 text-[var(--hb-muted)]">
              <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden /> The deposit desk is unavailable in the simple view: its chat runs inside AG Studio.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--hb-line)] bg-[var(--hb-card)] px-3.5 py-1.5 font-medium hover:border-[var(--hb-ink)]/40"
        >
          <RotateCw className="h-4 w-4" aria-hidden /> Try AG Studio again
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Kpi title="Held on PayPal now" subtitle="Reserved, not taken" value={formatUsd(kpis.heldNowCents)} color="var(--hb-held)" />
        <Kpi title="Kept this month" subtitle={`Settled in ${month}, after refunds`} value={formatUsd(kpis.keptThisMonthCents)} color="var(--hb-charged)" />
        <Kpi title="Released to renters" subtitle="Given back by PayPal at settlement" value={formatUsd(kpis.releasedCents)} color="var(--hb-released)" />
        <Kpi title="Refunded" subtitle="After settling, and cancelled fees" value={formatUsd(kpis.refundedCents)} color="var(--hb-released)" />
        <Kpi title="Open PayPal disputes" subtitle="Answered from the record" value={String(kpis.openDisputes)} color="var(--hb-ink)" />
        <Kpi title="Pickups photographed" subtitle="No photo, no hold: the counter refuses" value={share === null ? "–" : `${Math.round(share * 100)}%`} color="var(--hb-brand)" />
        <Kpi
          title="Minutes, return photo to release"
          subtitle="Median over settled rentals"
          value={kpis.medianMinutesReturnToSettled === null ? "–" : kpis.medianMinutesReturnToSettled.toLocaleString("en-US", { maximumFractionDigits: 1 })}
          color="var(--hb-released)"
        />
      </div>

      <div className="space-y-3">
        <Panel title="Where the deposits went" subtitle="From the holds to what was released, kept, refunded or disputed">
          <div className="h-[420px]">{flows.length ? <DepositFlowChart flows={flows} fmt={(v) => formatUsd(Math.round(v * 100))} /> : <Empty />}</div>
        </Panel>
        <Panel
          title="Hold clock"
          subtitle={`Each running hold over PayPal's 29 days: 72-hour honor period, renewal, expiry. ${kpis.holdsNeedingAttention} need${kpis.holdsNeedingAttention === 1 ? "s" : ""} a person.`}
        >
          <div style={{ height: holds.length ? clockHeight : undefined }}>
            {holds.length ? <HoldClockChart holds={holds} fmtMoney={(v) => formatUsd(Math.round(v * 100))} /> : <Empty text="No deposit is held on PayPal right now." />}
          </div>
        </Panel>
      </div>

      <Panel title="Every PayPal movement" subtitle={`${ledger.length} movement${ledger.length === 1 ? "" : "s"}, newest first; net to the shop ${formatUsd(net)}. Times are UTC.`}>
        {ledger.length ? (
          <div className="max-h-[520px] overflow-auto rounded-xl border border-[var(--hb-line)]">
            <table className="w-full min-w-[880px] border-collapse text-left text-xs" data-testid="simple-ledger">
              <thead className="sticky top-0 bg-[var(--hb-paper)] text-[var(--hb-muted)]">
                <tr>
                  {["When", "Rental", "Item", "Movement", "PayPal id", "Acts on", "Amount", "Net to shop", "PayPal status"].map((h) => (
                    <th key={h} scope="col" className={cx("px-3 py-2 font-semibold", (h === "Amount" || h === "Net to shop") && "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--hb-line)]">
                    <td className="whitespace-nowrap px-3 py-1.5 text-[var(--hb-muted)]">{utcMoment(l.at)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono">{l.rentalId}</td>
                    <td className="px-3 py-1.5">{l.item ?? ""}</td>
                    <td className="px-3 py-1.5">{l.kind}</td>
                    <td className="px-3 py-1.5 font-mono">{l.paypalId ?? ""}</td>
                    <td className="px-3 py-1.5 font-mono text-[var(--hb-muted)]">{l.relatedPaypalId ?? ""}</td>
                    <td className="tabular whitespace-nowrap px-3 py-1.5 text-right">{formatUsd(l.amountCents)}</td>
                    <td className={cx("tabular whitespace-nowrap px-3 py-1.5 text-right", l.netCents < 0 && "text-[var(--hb-charged)]")}>{formatUsd(l.netCents)}</td>
                    <td className="px-3 py-1.5 text-[var(--hb-muted)]">{l.status ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No PayPal movement yet." />
        )}
      </Panel>
    </div>
  );
}

const Empty = ({ text = "Nothing to show yet." }: { text?: string }) => <p className="grid h-full min-h-24 place-items-center text-sm text-[var(--hb-muted)]">{text}</p>;
