import type { Summary } from "./model";
import type { StudioDataSpec } from "./studio-data";

/**
 * The dashboard's simple view, shown when AG Studio does not load: the
 * Overview's KPIs, the two custom widgets and the ledger, from the data the
 * page already sent for AG Studio. Pure and free of AG Studio, so the browser
 * can draw it whatever happened to Studio's code.
 */

/** The Overview's KPIs, as the server computed them in integer cents (the same sums AG Studio's value widgets take). */
export type SimpleKpis = {
  heldNowCents: number;
  keptThisMonthCents: number;
  releasedCents: number;
  refundedCents: number;
  openDisputes: number;
  pickupsPhotographedShare: number | null;
  medianMinutesReturnToSettled: number | null;
  holdsNeedingAttention: number;
};

export const simpleKpis = (s: Summary): SimpleKpis => ({
  heldNowCents: s.held_now_cents,
  keptThisMonthCents: s.kept_this_month_cents,
  releasedCents: s.released_cents,
  refundedCents: s.refunded_cents,
  openDisputes: s.open_disputes,
  pickupsPhotographedShare: s.pickups_photographed_share,
  medianMinutesReturnToSettled: s.median_minutes_return_to_settled,
  holdsNeedingAttention: s.holds_needing_attention,
});

/** One band of "Where the deposits went", in dollars as the widget draws it. */
export type FlowLine = { from: string; to: string; value: number };

/** One row of the hold clock; times in epoch milliseconds. */
export type ClockHold = {
  id: string;
  label: string | null;
  heldAt: number;
  renewalDue: number | null;
  expiresAt: number;
  renewedAt: number | null;
  attention: string | null;
  amount: number | null;
};

export type LedgerLine = {
  id: string;
  at: string;
  rentalId: string;
  item: string | null;
  kind: string;
  paypalId: string | null;
  relatedPaypalId: string | null;
  amountCents: number;
  netCents: number;
  status: string | null;
};

type Row = Record<string, string | number | boolean | null>;

const rows = (spec: StudioDataSpec, id: string): Row[] => spec.sources.find((s) => s.id === id)?.data ?? [];
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ms = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export function simpleViewData(spec: StudioDataSpec): { flows: FlowLine[]; holds: ClockHold[]; ledger: LedgerLine[] } {
  const flows = rows(spec, "flows")
    .map((r) => ({ from: String(r.from ?? ""), to: String(r.to ?? ""), value: Number(r.amount_usd ?? 0) }))
    .filter((f) => f.value > 0);

  const holds: ClockHold[] = [];
  for (const r of rows(spec, "holds")) {
    const heldAt = ms(r.held_at);
    const expiresAt = ms(r.expires_at);
    if (heldAt === null || expiresAt === null) continue;
    holds.push({
      id: String(r.rental_id),
      label: str(r.item),
      heldAt,
      renewalDue: ms(r.renewal_due_at),
      expiresAt,
      renewedAt: ms(r.renewed_at),
      attention: str(r.attention),
      amount: typeof r.amount_usd === "number" ? r.amount_usd : null,
    });
  }
  holds.sort((a, b) => a.expiresAt - b.expiresAt);

  const items = new Map(rows(spec, "rentals").map((r) => [String(r.rental_id), str(r.item)]));
  const ledger = rows(spec, "ledger")
    .map((r) => ({
      id: String(r.movement_id),
      at: String(r.at ?? ""),
      rentalId: String(r.rental_id ?? ""),
      item: items.get(String(r.rental_id)) ?? null,
      kind: String(r.kind ?? ""),
      paypalId: str(r.paypal_id),
      relatedPaypalId: str(r.related_paypal_id),
      amountCents: Number(r.amount_cents ?? 0),
      netCents: Number(r.shop_net_cents ?? 0),
      status: str(r.status),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));

  return { flows, holds, ledger };
}

/** "Oct 14, 09:05 UTC": the same on the server and in any browser, like the rest of Handback's times. */
export const utcMoment = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
};
