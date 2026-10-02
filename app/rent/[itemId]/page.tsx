import { notFound } from "next/navigation";
import { BookingForm } from "@/components/booking-form";
import { StoreHeader } from "@/components/headers";
import { Badge, Card, Eyebrow } from "@/components/ui";
import { CATALOG } from "@/lib/catalog";
import { todayIso } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import { paypalConfig } from "@/lib/paypal/config";
import { SHOP } from "@/lib/shop";

export const dynamic = "force-dynamic";

const SAMPLE: Record<string, string> = { ebike: "ebike-rear" };

export default async function BookItem(props: PageProps<"/rent/[itemId]">) {
  const { itemId } = await props.params;
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item) notFound();
  const cfg = paypalConfig();

  return (
    <>
      <StoreHeader />
      <main className="mx-auto grid max-w-6xl gap-6 px-5 pb-16 lg:grid-cols-[1.1fr_1fr] lg:gap-8">
        <div className="space-y-6 lg:col-start-1 lg:row-start-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/samples/${SAMPLE[item.id] ?? item.id}/before`} alt={item.name} className="w-full rounded-[var(--radius-card)] border border-line object-cover" />
          <div>
            <Badge>{item.category}</Badge>
            <h1 className="mt-2 font-display text-4xl font-bold tracking-tight">{item.name}</h1>
            <p className="mt-2 text-ink-soft">
              <span className="tabular font-semibold text-ink">{formatUsd(item.dailyCents)}</span> per day ·{" "}
              <span className="text-held">{formatUsd(item.depositCents)} deposit held at pickup</span>
            </p>
          </div>
        </div>
        <Card className="h-fit p-6 lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <h2 className="font-display text-2xl font-bold">Book it</h2>
          <p className="mt-1 text-sm text-muted">Pick up and return at {SHOP.name}, {SHOP.city}.</p>
          <div className="mt-5">
            <BookingForm
              itemId={item.id}
              dailyCents={item.dailyCents}
              depositCents={item.depositCents}
              maxDays={SHOP.maxRentalDays}
              today={todayIso()}
              paypal={cfg.mode === "demo" ? null : { clientId: cfg.clientId, environment: cfg.mode === "live" ? "production" : "sandbox" }}
            />
          </div>
        </Card>
        <div className="space-y-6 lg:col-start-1 lg:row-start-2">
          <Card className="p-5">
            <Eyebrow>In the box</Eyebrow>
            <ul className="mt-3 flex flex-wrap gap-2">
              {item.kit.map((k) => (
                <li key={k} className="rounded-full bg-paper px-3 py-1 text-sm">
                  {k}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-5">
            <Eyebrow>If something comes back damaged or missing</Eyebrow>
            <p className="mt-2 text-sm text-ink-soft">
              These are the only amounts the shop can take from your deposit, and only after you have seen the photos. Normal wear is never charged.
            </p>
            <table className="mt-3 w-full text-sm">
              <tbody>
                {item.prices.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-2 pr-3">{p.label}</td>
                    <td className="tabular py-2 text-right font-semibold">{formatUsd(p.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </main>
    </>
  );
}
