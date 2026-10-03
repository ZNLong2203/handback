import { CheckCircle2, Clock3, Receipt } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { acknowledgeCheckoutAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { ApproveBooking } from "@/components/approve-booking";
import { StoreHeader } from "@/components/headers";
import { InspectionView } from "@/components/inspection-view";
import { LiveRefresh } from "@/components/live-refresh";
import { MandateCard } from "@/components/mandate-card";
import { MoneyBar } from "@/components/money-bar";
import { Timeline } from "@/components/timeline";
import { Badge, Card, Eyebrow, Notice } from "@/components/ui";
import { shortDate } from "@/lib/dates";
import { utc } from "@/lib/disputes/facts";
import { formatUsd } from "@/lib/money";
import { captureRefusal, returnFromPayPal } from "@/lib/rentals/service";
import { feePending, STATUS } from "@/lib/rentals/status";
import { loadRentalView } from "@/lib/rentals/view";
import { SHOP } from "@/lib/shop";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your rental", robots: { index: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CustomerRental(props: PageProps<"/r/[token]">) {
  const { token } = await props.params;
  const query = await props.searchParams;
  // PayPal sends the renter back here after they approve. The capture runs
  // once, on the server, and the page then moves off PayPal's URL either way,
  // so neither a reload nor a live update can run it again.
  const fromPayPal = { token: one(query.token), PayerID: one(query.PayerID) };
  const back = fromPayPal.token ? await returnFromPayPal(token, fromPayPal) : "none";
  if (back === "approved" || back === "pending") redirect(`/r/${token}`);
  if (back === "failed") redirect(`/r/${token}?paypal=failed`);

  const view = await loadRentalView({ token });
  if (!view) notFound();
  const { rental, item, checkout, checkin, assessment, plan } = view;
  const status = STATUS[rental.status];
  const firstName = rental.customerName.split(" ")[0];
  const byAssistant = view.mandate?.mandate.issuedTo.party === "assistant";
  const processing = feePending(rental);
  const refused =
    one(query.paypal) === "failed" && rental.status === "draft" && !processing ? (captureRefusal(view.events) ?? "Approve the booking in PayPal again.") : null;
  const settled = rental.status === "settled" || rental.status === "disputed";
  const dispute = view.dispute;
  const evidenceSent = Boolean(dispute && view.events.some((e) => e.type === "dispute.evidence_sent" && e.data.disputeId === dispute.id));

  return (
    <>
      <StoreHeader />
      <main className="mx-auto max-w-3xl space-y-5 px-5 pb-16">
        <Card className="animate-rise p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Eyebrow>Rental {rental.id}</Eyebrow>
              <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">
                Hi {firstName}, your {item.name.toLowerCase()}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {shortDate(rental.startDate)} → {shortDate(rental.endDate)} · {rental.days} day{rental.days > 1 ? "s" : ""} · {SHOP.name}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge tone={processing ? "held" : (status.customerTone ?? status.tone)}>{processing ? "Payment processing" : (status.customerLabel ?? status.label)}</Badge>
              <LiveRefresh channel={rental.id} />
            </div>
          </div>
          <p className="mt-4 text-ink-soft">{processing ? "Your booking is confirmed when PayPal finishes processing the payment." : status.customer}</p>
          {rental.status !== "cancelled" && (
            <div className="mt-5">
              {settled ? (
                <MoneyBar
                  state="settled"
                  size="lg"
                  authorizedCents={rental.authorizedCents ?? 0}
                  capturedCents={rental.capturedCents ?? 0}
                  releasedCents={rental.releasedCents ?? 0}
                  extraCents={rental.extraCents ?? 0}
                  refundedCents={view.refundedCents}
                />
              ) : rental.authorizedCents && plan && (rental.status === "customer_review" || rental.status === "responded") ? (
                <MoneyBar state="proposed" size="lg" authorizedCents={rental.authorizedCents} proposedCents={plan.totalCents} />
              ) : rental.authorizedCents ? (
                <MoneyBar state="held" size="lg" authorizedCents={rental.authorizedCents} />
              ) : (
                <MoneyBar state="none" size="lg" depositCents={rental.depositCents} />
              )}
            </div>
          )}
        </Card>

        {processing && (
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold">
              <Clock3 className="h-5 w-5 text-held" aria-hidden /> PayPal is still processing your payment
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              You approved the {formatUsd(rental.feeCents)} rental fee and PayPal accepted it, but has not finished processing it. There is nothing to pay
              again. The booking is confirmed when PayPal confirms the payment, and this page updates by itself. If PayPal declines it, nothing is charged
              and this page says so.
            </p>
          </Card>
        )}

        {rental.status === "draft" && !processing && (
          <ApproveBooking rental={rental} item={item} byAssistant={byAssistant}>
            {refused && (
              <Notice tone="charged" title="PayPal did not complete the payment">
                {refused}
              </Notice>
            )}
          </ApproveBooking>
        )}

        {rental.status === "cancelled" && (
          <Card className="p-6">
            <h2 className="font-semibold">This booking was not paid</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {captureRefusal(view.events) ?? "Nothing was charged."}{" "}
              <Link href={`/rent/${item.id}`} className="font-semibold underline underline-offset-2">
                Book the {item.name.toLowerCase()} again
              </Link>
              .
            </p>
          </Card>
        )}

        {rental.status === "draft" && view.mandate && <MandateCard {...view.mandate} />}

        {rental.status === "booked" && (
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="h-5 w-5 text-released" aria-hidden /> Paid {formatUsd(rental.feeCents)} with PayPal
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              At pickup the shop photographs the item with you and holds the {formatUsd(rental.depositCents)} deposit on your PayPal. A hold is not a
              charge. Keep this page: it updates by itself at every step.
            </p>
          </Card>
        )}

        {checkout && ["out", "booked"].includes(rental.status) && (
          <Card className="p-6">
            <h2 className="font-semibold">The item as you received it</h2>
            <p className="mt-1 text-sm text-muted">This photo is what the return is compared against. Check that it shows the item as you got it.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/photos/${checkout.photoSha}`} alt="Pickup photo" className="mt-4 w-full rounded-2xl border border-line" />
            <p className="mt-2 break-all font-mono text-[11px] text-muted">sha256 {checkout.photoSha}</p>
            {checkout.acknowledgedAt ? (
              <p className="mt-3 flex items-center gap-2 text-sm font-medium text-released">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> You confirmed this photo on {new Date(checkout.acknowledgedAt).toLocaleString("en-US")}.
              </p>
            ) : (
              <ActionButton className="mt-4" variant="brand" action={acknowledgeCheckoutAction.bind(null, token)} pendingLabel="Saving…">
                Yes, this is how I received it
              </ActionButton>
            )}
          </Card>
        )}

        {rental.status === "inspecting" && (
          <Notice tone="held" title="Thanks for bringing it back">
            The shop is comparing the return photo with the pickup photo. If they think anything should be charged, you will see it here first, with the
            photos, and you can question it.
          </Notice>
        )}

        {assessment && checkout && checkin && ["customer_review", "responded", "settled", "disputed"].includes(rental.status) && (
          <Card className="p-6">
            <h2 className="font-display text-2xl font-bold">
              {rental.status === "customer_review" ? "Please review what the shop found" : settled ? "What was decided" : "Your answers"}
            </h2>
            {rental.status === "customer_review" && (
              <p className="mt-1 text-sm text-muted">
                Tap a numbered box to see it on the photos. Accept what is fair; question anything that isn&apos;t. Nothing is charged until the shop has read
                your answers.
              </p>
            )}
            {rental.status === "responded" && (
              <p className="mt-1 flex items-center gap-2 text-sm text-muted">
                <Clock3 className="h-4 w-4" aria-hidden /> Sent. Anything you questioned is decided by a person at the shop.
              </p>
            )}
            <div className="mt-5">
              <InspectionView
                checkoutSha={checkout.photoSha}
                checkinSha={checkin.photoSha}
                findings={assessment.findings}
                mode={rental.status === "customer_review" ? "customer" : "readonly"}
                token={token}
              />
            </div>
          </Card>
        )}

        {dispute &&
          (dispute.status === "RESOLVED" ? (
            <Notice tone="note" title="PayPal closed the case">
              {dispute.outcome === "RESOLVED_BUYER_FAVOUR"
                ? `PayPal decided in your favour and refunded ${formatUsd(dispute.refundedCents ?? dispute.amountCents ?? 0)} to your PayPal account.`
                : dispute.outcome === "RESOLVED_SELLER_FAVOUR"
                  ? "PayPal reviewed the case and decided the charge stands."
                  : dispute.outcome === "CANCELED_BY_BUYER"
                    ? "You withdrew the case."
                    : "PayPal has closed the case."}{" "}
              PayPal&apos;s email has the details.
            </Notice>
          ) : (
            <Notice tone="note" title="Your case with PayPal">
              You asked PayPal to look at {dispute.amountCents !== null ? `${formatUsd(dispute.amountCents)} of ` : ""}this rental&apos;s charges
              {dispute.openedAt ? ` on ${utc(dispute.openedAt).slice(0, 10)}` : ""}. PayPal decides from what you and the shop send it.{" "}
              {evidenceSent ? "The shop has sent PayPal the same photos and answers you see on this page. " : ""}PayPal will email you; you do not need to do
              anything here.
            </Notice>
          ))}

        {view.refunds
          .filter((r) => r.state === "done" && r.paypalStatus !== "FAILED" && r.paypalStatus !== "CANCELLED")
          .map((r) => (
            <Notice key={r.id} tone="released" title={`The shop refunded ${formatUsd(r.amountCents)} to you`}>
              {r.reason ? <span className="mb-1 block">&ldquo;{r.reason}&rdquo;</span> : null}
              {r.paypalStatus === "PENDING"
                ? "PayPal is processing the refund and sends it back the way you paid."
                : "PayPal sends it back the way you paid. If a card funds your PayPal, your card issuer decides when it shows."}
            </Notice>
          ))}

        {settled && (
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-display text-2xl font-bold">
              <Receipt className="h-6 w-6" aria-hidden /> Receipt
            </h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Rental fee (paid at booking)</dt>
                <dd className="tabular font-semibold">{formatUsd(rental.feeCents)}</dd>
              </div>
              {plan?.lines.map((l) => (
                <div key={l.findingId} className="flex justify-between">
                  <dt className="text-muted">{l.label}</dt>
                  <dd className="tabular font-semibold text-charged">{formatUsd(l.cents)}</dd>
                </div>
              ))}
              {view.refundedCents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Refunded by the shop afterwards</dt>
                  <dd className="tabular font-semibold text-released">−{formatUsd(view.refundedCents)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-line pt-2">
                <dt className="font-semibold text-released">Deposit released to your PayPal</dt>
                <dd className="tabular font-bold text-released">{formatUsd(rental.releasedCents ?? 0)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">
              Released on PayPal {rental.settledAt ? new Date(rental.settledAt).toLocaleString("en-US") : ""}. If your PayPal is funded by a card, your card
              issuer decides when its pending line disappears.
            </p>
          </Card>
        )}

        {rental.status !== "draft" && view.mandate && <MandateCard {...view.mandate} folded />}

        <details className="rounded-[var(--radius-card)] border border-line bg-card p-5">
          <summary className="cursor-pointer font-semibold">Everything that happened, step by step</summary>
          <div className="mt-4">
            <Timeline events={view.events} intact={view.chainIntact} />
          </div>
        </details>
      </main>
    </>
  );
}
