import { notFound } from "next/navigation";
import { ApproveBooking } from "@/components/approve-booking";
import { StoreHeader } from "@/components/headers";
import { MandateCard } from "@/components/mandate-card";
import { Card, Eyebrow } from "@/components/ui";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { openMandate } from "@/lib/rentals/mandate";
import { rentalByOrder } from "@/lib/rentals/repo";
import { feePending } from "@/lib/rentals/status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Back from PayPal", robots: { index: false } };

/**
 * PayPal's cancel URL (paypalCancelUrl in service.ts), found by the order id
 * PayPal appends. Its link works without logging in to PayPal, so whoever
 * holds the approval link can land here: the page offers the way back to
 * PayPal and the terms, and never the renter's own page or anything on it.
 */
export default async function LeftPayPal(props: PageProps<"/paypal/cancelled">) {
  const { token } = await props.searchParams;
  const rental = typeof token === "string" ? await rentalByOrder(await getDb(), token) : null;
  if (!rental) notFound();
  const item = catalogItem(rental.itemId);
  const opened = rental.mandateJson && rental.mandateSha256 ? openMandate(rental.mandateJson, rental.mandateSha256) : null;
  const waiting = rental.status === "draft" && !feePending(rental);

  return (
    <>
      <StoreHeader />
      <main className="mx-auto max-w-3xl space-y-5 px-5 pb-16">
        <Card className="animate-rise p-6">
          <Eyebrow>Rental {rental.id}</Eyebrow>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">{waiting ? "You left PayPal without paying" : "Nothing to approve here"}</h1>
          <p className="mt-2 text-ink-soft">
            {waiting
              ? `Nothing was charged. The booking of the ${item.name.toLowerCase()} waits until it is approved in PayPal. After you approve, PayPal takes you to your own rental page, where you follow the rental and answer any charges.`
              : "This booking is no longer waiting for approval in PayPal. After approving, PayPal opens the renter's own rental page; the shop can show its link again."}
          </p>
        </Card>
        {waiting && (
          <>
            <ApproveBooking rental={rental} item={item} byAssistant={opened?.mandate.issuedTo.party === "assistant"} />
            {opened && <MandateCard {...opened} json={rental.mandateJson!} sha256={rental.mandateSha256!} />}
          </>
        )}
      </main>
    </>
  );
}
