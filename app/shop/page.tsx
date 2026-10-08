import { ArrowUpRight, CalendarRange, Plus } from "lucide-react";
import Link from "next/link";
import { DemoResetNote } from "@/components/demo-reset-note";
import { ShopHeader } from "@/components/headers";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, ButtonLink, Card, Eyebrow } from "@/components/ui";
import { catalogItem } from "@/lib/catalog";
import { shortDate } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { formatUsd } from "@/lib/money";
import { feeRefundTotals, refundTotals } from "@/lib/rentals/refunds";
import { listRentals } from "@/lib/rentals/repo";
import { STATUS } from "@/lib/rentals/status";
import type { Rental, RentalStatus } from "@/lib/rentals/types";
import { handovers, type Handover } from "@/lib/schedule/handover";
import { requireStaffPage } from "@/lib/staff-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Counter" };

const GROUPS: { title: string; hint: string; statuses: RentalStatus[] }[] = [
  { title: "Needs your eyes", hint: "Returns to review, or customer answers to read", statuses: ["inspecting", "responded", "disputed"] },
  { title: "Picking up", hint: "Paid; photograph and hold the deposit", statuses: ["booked"] },
  { title: "Out now", hint: "Deposit held on PayPal", statuses: ["out"] },
  { title: "With the customer", hint: "Waiting for their answers", statuses: ["customer_review"] },
  { title: "Settled", hint: "Deposit charged or released", statuses: ["settled"] },
  { title: "Cancelled", hint: "Before pickup; the unit is free again", statuses: ["cancelled"] },
];

/** A cancelled booking whose refund PayPal has not completed: still waiting for PayPal's answer, or short of what the cancellation decided. */
function refundFlag(r: Rental, fee: { refundedCents: number; waitingCents: number }): string | null {
  if (r.status !== "cancelled" || !r.cancelledAt || !r.feeCaptureId) return null;
  if (fee.waitingCents > 0) return `Refund of ${formatUsd(fee.waitingCents)} waiting for PayPal's answer`;
  const short = (r.cancelRefundCents ?? 0) - fee.refundedCents;
  return short > 0 ? `${formatUsd(short)} of the cancellation refund not refunded: send it again` : null;
}

function RentalRow({ r, unit, refunded = 0, fee = { refundedCents: 0, waitingCents: 0 } }: { r: Rental; unit?: Handover; refunded?: number; fee?: { refundedCents: number; waitingCents: number } }) {
  const item = catalogItem(r.itemId);
  const status = STATUS[r.status];
  const flag = refundFlag(r, fee);
  const money =
    r.status === "cancelled"
      ? r.cancelledAt && r.feeCaptureId
        ? `${formatUsd(fee.refundedCents)} of ${formatUsd(r.feeCents)} fee refunded`
        : "Nothing paid"
      : r.status === "settled"
      ? `${formatUsd(r.releasedCents ?? 0)} released${r.capturedCents ? ` · ${formatUsd(r.capturedCents)} kept` : ""}${refunded ? ` · ${formatUsd(refunded)} refunded` : ""}`
      : r.authorizedCents
        ? `${formatUsd(r.authorizedCents)} held`
        : `${formatUsd(r.depositCents)} at pickup`;
  return (
    <li>
      <Link
        href={`/shop/rentals/${r.id}`}
        className="group grid grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 transition hover:border-ink/25 sm:grid-cols-[7rem_1fr_auto_auto]"
      >
        <span className="hidden font-mono text-xs text-muted sm:block">{r.id}</span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">
            {r.customerName}
            {/* On a phone the id and the money sit inside this column instead of their own. */}
            <span className="ml-2 font-mono text-xs font-normal text-muted sm:hidden">{r.id}</span>
          </span>
          <span className="block truncate text-sm text-muted">
            {item.name} · {unit && r.status !== "cancelled" ? `${r.status === "booked" ? "hand over " : ""}${unit.label} · ` : ""}
            {shortDate(r.startDate)}–{shortDate(r.endDate)}
          </span>
          <span className="tabular block truncate text-sm text-ink-soft sm:hidden">{money}</span>
          {unit?.warning && <span className="block truncate text-xs font-medium text-charged">{unit.warning}</span>}
          {flag && <span className="block truncate text-xs font-medium text-charged">{flag}</span>}
        </span>
        <span className="tabular hidden text-sm text-ink-soft sm:block">{money}</span>
        <span className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <ArrowUpRight className="h-4 w-4 text-muted transition group-hover:text-ink" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

export default async function Counter() {
  await requireStaffPage("/shop");
  const db = await getDb();
  const rentals = await listRentals(db);
  const units = await handovers(rentals);
  const refunds = await refundTotals(db);
  const feeRefunds = await feeRefundTotals(db);
  const held = rentals.filter((r) => ["out", "inspecting", "customer_review", "responded"].includes(r.status)).reduce((s, r) => s + (r.authorizedCents ?? 0), 0);
  const settled = rentals.filter((r) => r.status === "settled");
  const released = settled.reduce((s, r) => s + (r.releasedCents ?? 0), 0);
  const kept = settled.reduce((s, r) => s + (r.capturedCents ?? 0) + (r.extraCents ?? 0) - (refunds.get(r.id) ?? 0), 0);
  const attention = rentals.filter((r) => ["inspecting", "responded", "disputed"].includes(r.status)).length;

  return (
    <>
      <ShopHeader live={<LiveRefresh channel="shop" />} />
      <main className="mx-auto max-w-6xl space-y-8 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Counter</Eyebrow>
            <h1 className="mt-1 font-display text-4xl font-bold tracking-tight">Today at the counter</h1>
            <DemoResetNote audience="counter" className="mt-2 max-w-xl" />
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/shop/schedule" variant="primary">
              <CalendarRange className="h-4 w-4" aria-hidden /> Schedule
            </ButtonLink>
            <ButtonLink href="/rent" variant="outline" target="_blank">
              <Plus className="h-4 w-4" aria-hidden /> New booking (customer view)
            </ButtonLink>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[
            { label: "Held on PayPal now", value: formatUsd(held), tone: "text-held" },
            { label: "Released to customers", value: formatUsd(released), tone: "text-released" },
            { label: "Kept for repairs", value: formatUsd(kept), tone: "text-charged" },
            { label: "Need your eyes", value: String(attention), tone: attention ? "text-charged" : "text-ink" },
          ].map((k) => (
            <Card key={k.label} className="flex flex-col justify-between p-4 sm:p-5">
              <p className="text-sm text-muted">{k.label}</p>
              <p className={`tabular mt-1 font-display text-2xl font-bold sm:text-3xl ${k.tone}`}>{k.value}</p>
            </Card>
          ))}
        </div>

        {rentals.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="font-display text-2xl font-bold">No rentals yet</p>
            <p className="mt-2 text-muted">Open the customer side in another tab and book something. It shows up here the moment PayPal confirms.</p>
            <ButtonLink href="/rent" variant="brand" className="mt-5" target="_blank">
              Open the customer side
            </ButtonLink>
          </Card>
        ) : (
          GROUPS.map((g) => {
            const list = rentals.filter((r) => g.statuses.includes(r.status));
            if (list.length === 0) return null;
            return (
              <section key={g.title}>
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <h2 className="font-display text-xl font-bold">{g.title}</h2>
                  <span className="text-sm text-muted">{g.hint}</span>
                </div>
                <ul className="space-y-2">
                  {list.map((r) => (
                    <RentalRow key={r.id} r={r} unit={units.get(r.id)} refunded={refunds.get(r.id)} fee={feeRefunds.get(r.id)} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </main>
    </>
  );
}
