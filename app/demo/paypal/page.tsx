import { notFound, redirect } from "next/navigation";
import { ModeStrip } from "@/components/headers";
import { ButtonAnchor, Card, Eyebrow } from "@/components/ui";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { formatUsd } from "@/lib/money";
import { paypalConfig } from "@/lib/paypal/config";
import { rentalByOrder } from "@/lib/rentals/repo";
import { SHOP } from "@/lib/shop";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demo approval", robots: { index: false } };

/**
 * Demo mode only: stands in for PayPal's approval page, so a booking made by
 * an assistant can be approved without PayPal keys. It sends the renter back
 * the way PayPal does (?token=<order id>&PayerID=… or the cancel URL), so the
 * rental page runs the same capture code as in the sandbox.
 */
export default async function DemoPayPalApproval(props: PageProps<"/demo/paypal">) {
  if (paypalConfig().mode !== "demo") notFound();
  const { token } = await props.searchParams;
  const orderId = typeof token === "string" ? token : null;
  const rental = orderId ? await rentalByOrder(await getDb(), orderId) : null;
  if (!orderId || !rental) notFound();
  if (rental.status !== "draft") redirect(`/r/${rental.token}`);
  const item = catalogItem(rental.itemId);
  const back = `/r/${rental.token}`;

  return (
    <>
      <ModeStrip />
      <main className="mx-auto max-w-md px-5 py-10">
        <Card className="p-6">
          <Eyebrow>Demo stand-in for PayPal</Eyebrow>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">Approve {SHOP.name}</h1>
          <dl className="mt-4 space-y-2 rounded-2xl bg-paper p-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">
                {item.name}, {rental.days} day{rental.days > 1 ? "s" : ""}
              </dt>
              <dd className="tabular font-semibold">{formatUsd(rental.feeCents)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-held">
              <dt>Saved for a deposit hold at pickup, up to</dt>
              <dd className="tabular font-semibold">{formatUsd(rental.depositCents)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            With PayPal keys set, this step happens on PayPal&apos;s own site: {rental.customerName} logs in and approves there. In demo mode no money moves.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <ButtonAnchor href={`${back}?token=${encodeURIComponent(orderId)}&PayerID=DEMOPAYER`} variant="brand" size="lg">
              Approve and pay {formatUsd(rental.feeCents)}
            </ButtonAnchor>
            <ButtonAnchor href={`${back}?paypal=cancelled&token=${encodeURIComponent(orderId)}`} variant="ghost">
              Cancel and go back
            </ButtonAnchor>
          </div>
        </Card>
      </main>
    </>
  );
}
