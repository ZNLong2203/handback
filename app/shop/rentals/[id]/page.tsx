import { ArrowLeft, CheckCircle2, ExternalLink, Sparkles } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  clearHoldClaimAction,
  demoOpenDisputeAction,
  findDisputesAction,
  holdDepositAction,
  inspectAction,
  resendRefundAction,
  sendToCustomerAction,
  settleAction,
} from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { CancelForm } from "@/components/cancel-form";
import { CancellationReceipt } from "@/components/cancellation-receipt";
import { DisputePanel } from "@/components/dispute-panel";
import { ShopHeader } from "@/components/headers";
import { InspectionView } from "@/components/inspection-view";
import { LiveRefresh } from "@/components/live-refresh";
import { MoneyBar } from "@/components/money-bar";
import { PhotoCapture } from "@/components/photo-capture";
import { RefundForm } from "@/components/refund-form";
import { Qr } from "@/components/qr";
import { UnitHandover } from "@/components/schedule/unit-handover";
import { Timeline } from "@/components/timeline";
import { Badge, Card, Eyebrow, Notice, cx } from "@/components/ui";
import { shortDate } from "@/lib/dates";
import { loadDisputeDesk } from "@/lib/disputes/service";
import { readDraft, type RefundDraft } from "@/lib/insights/draft-link";
import { paypalConfig } from "@/lib/paypal/config";
import { formatUsd } from "@/lib/money";
import { samplesFor } from "@/lib/samples";
import { quoteCancellation } from "@/lib/rentals/cancel";
import { renewalDueAt } from "@/lib/rentals/jobs";
import { awaitingResolution } from "@/lib/rentals/settlement";
import { feePending, STATUS, STEPS, stepIndex } from "@/lib/rentals/status";
import { loadRentalView, type RentalView } from "@/lib/rentals/view";
import { appUrl } from "@/lib/shop";
import { requireStaffPage } from "@/lib/staff-access";

export const dynamic = "force-dynamic";

function Steps({ status }: { status: RentalView["rental"]["status"] }) {
  const at = stepIndex(status);
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Rental progress">
      {STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === at ? "step" : undefined}>
          <div className={cx("h-1.5 rounded-full", i < at || status === "settled" ? "bg-released" : i === at ? "bg-held" : "bg-line")} />
          <p className={cx("mt-1.5 text-xs", i === at ? "font-semibold text-ink" : "text-muted")}>{s.label}</p>
        </li>
      ))}
    </ol>
  );
}

function Photo({ sha, label }: { sha: string; label: string }) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-card">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/photos/${sha}`} alt={label} className="w-full" />
      <figcaption className="flex justify-between px-4 py-2 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="font-mono text-xs text-muted">sha256 {sha.slice(0, 10)}…</span>
      </figcaption>
    </figure>
  );
}

/**
 * Refunds of what the shop took: a settlement's charges, or the fee of a
 * cancelled booking. `draft` is a refund the dashboard's deposit desk
 * drafted, from a signed link (lib/insights/draft-link.ts): it only fills
 * the form in.
 */
function Refunds({ view, disputeOpen, draft }: { view: RentalView; disputeOpen: boolean; draft: RefundDraft | null }) {
  const { rental } = view;
  const refundLeft = view.refundable.some((c) => c.leftCents > 0);
  const captureLabel = (captureId: string) =>
    view.refundable.find((c) => c.captureId === captureId)?.label ?? (captureId === rental.feeCaptureId ? "the rental fee" : `capture ${captureId}`);
  return (
    (view.refunds.some((r) => r.state !== "refused") || refundLeft) && (
      <div id="refunds" className="mt-5 scroll-mt-24 space-y-3 border-t border-line pt-4">
        <h3 className="font-semibold">Refunds</h3>
        {view.waitingRefunds.map((r) => (
          <div key={r.id} className="space-y-2 rounded-2xl bg-held-soft p-4 text-sm">
            <p>
              Refund {r.seq}: <span className="tabular font-semibold">{formatUsd(r.amountCents)}</span> of {captureLabel(r.captureId)}
              {r.reason ? <span className="text-muted"> &ldquo;{r.reason}&rdquo;</span> : null}. It was sent to PayPal, but PayPal&apos;s answer
              was lost, so it may or may not have gone through.
            </p>
            {r.resendable ? (
              <ActionButton action={resendRefundAction.bind(null, rental.id, r.seq)} variant="outline" size="sm" pendingLabel="Asking PayPal…">
                Send refund {r.seq} again, unchanged
              </ActionButton>
            ) : (
              <p className="text-muted">
                Sent more than an hour ago, so sending it again could refund twice. Check the capture in PayPal; when PayPal reports the refund,
                it is recorded here.
              </p>
            )}
          </div>
        ))}
        {view.refunds
          .filter((r) => r.state === "done")
          .map((r) => (
            <div key={r.id} className="text-sm">
              <p>
                <span className="tabular font-semibold text-released">{formatUsd(r.amountCents)}</span> of {captureLabel(r.captureId)}
                {r.paypalStatus === "PENDING"
                    ? ": PayPal is processing it."
                    : r.paypalStatus === "FAILED" || r.paypalStatus === "CANCELLED"
                      ? `: PayPal reports it ${r.paypalStatus.toLowerCase()}.`
                      : r.source === "webhook"
                        ? ": refunded outside the counter, reported by PayPal."
                        : " refunded."}
                {r.reason ? <span className="text-muted"> &ldquo;{r.reason}&rdquo;</span> : null}
              </p>
              {r.refundId && <p className="font-mono text-xs text-muted">refund {r.refundId}</p>}
            </div>
          ))}
        {disputeOpen ? (
          <p className="max-w-prose text-sm text-muted">
            The customer has an open PayPal dispute on this rental. To give money back, use the dispute desk above, so PayPal counts it toward
            the case.
          </p>
        ) : refundLeft ? (
          <RefundForm rentalId={rental.id} captures={view.refundable} seq={view.nextRefundSeq} firstName={rental.customerName.split(" ")[0]} draft={draft} />
        ) : null}
      </div>
    )
  );
}

export default async function RentalAtCounter(props: PageProps<"/shop/rentals/[id]">) {
  const { id } = await props.params;
  await requireStaffPage(`/shop/rentals/${id}`);
  const draft = readDraft(id, await props.searchParams);
  const view = await loadRentalView({ id });
  if (!view) notFound();
  const { rental, item, checkout, checkin, assessment, plan } = view;
  const status = STATUS[rental.status];
  const customerUrl = `${appUrl()}/r/${rental.token}`;
  const kept = assessment?.findings.filter((f) => f.decision !== "note" && f.price && f.staff === "keep") ?? [];
  const desk = await loadDisputeDesk(view);
  // A dispute does not undo the settlement: the money view stays as it was.
  const settled = rental.status === "settled" || rental.status === "disputed";
  const paypalMode = paypalConfig().mode;
  const disputeOpen = Boolean(view.dispute && view.dispute.status !== "RESOLVED");
  const cancellable = rental.status === "booked" || rental.status === "draft";
  const cancel = cancellable ? quoteCancellation(rental, { feeLeftCents: view.feeCapture?.leftCents ?? 0, openDispute: view.openDispute, events: view.events }, "staff", new Date()) : null;
  const paid = rental.feeCaptureId !== null && !feePending(rental) && !(rental.status === "cancelled" && !rental.cancelledAt);

  return (
    <>
      <ShopHeader live={<LiveRefresh channel={rental.id} />} />
      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-5">
          <Link href="/shop" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden /> All rentals
          </Link>
          <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Eyebrow>
                  {rental.id} · {shortDate(rental.startDate)} → {shortDate(rental.endDate)}
                </Eyebrow>
                <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">{item.name}</h1>
                <p className="text-muted">for {rental.customerName}</p>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            {rental.status === "cancelled" ? (
              <p className="mt-5 text-sm font-medium text-ink-soft">
                {rental.cancelledAt
                  ? `Cancelled before pickup by ${rental.cancelledBy === "staff" ? "the counter" : "the customer"} on ${shortDate(rental.cancelledAt)}. The unit is free again.`
                  : "PayPal declined the fee, so the booking was cancelled with nothing charged."}
              </p>
            ) : (
              <>
                <div className="mt-6">
                  <Steps status={rental.status} />
                </div>
                <p className="mt-5 text-sm font-medium text-ink-soft">Next: {status.staffNext}.</p>
              </>
            )}
          </Card>

          {desk && <DisputePanel desk={desk} rental={rental} />}

          {rental.status === "booked" && (
            <Card className="space-y-5 p-6">
              <div>
                <h2 className="font-display text-2xl font-bold">Pickup</h2>
                <p className="mt-1 text-sm text-muted">Photograph the item with the customer at the counter, then hold the deposit.</p>
              </div>
              <UnitHandover rental={rental} />
              {checkout ? (
                <div className="space-y-4">
                  <Photo sha={checkout.photoSha} label="Pickup photo" />
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-held-soft p-4">
                    <ActionButton action={holdDepositAction.bind(null, rental.id)} variant="primary" size="lg" pendingLabel="Asking PayPal…">
                      Hold {formatUsd(rental.depositCents)} deposit
                    </ActionButton>
                    <p className="max-w-sm text-sm text-ink-soft">
                      On the PayPal account saved at booking. The customer does not need to approve again; PayPal holds it, nothing is charged.
                    </p>
                  </div>
                </div>
              ) : (
                <PhotoCapture rentalId={rental.id} phase="checkout" shot={item.shot} samples={samplesFor(item.id, "checkout")} />
              )}
            </Card>
          )}

          {cancel && (
            <Card className="space-y-4 p-6">
              <div>
                <h2 className="font-display text-2xl font-bold">Cancel the booking</h2>
                <p className="mt-1 text-sm text-muted">
                  {rental.status === "draft" ? "Not paid yet." : `Paid ${formatUsd(rental.feeCents)} at booking; no deposit is held before pickup.`}
                </p>
              </div>
              {cancel.blocked ? (
                <div className="space-y-3">
                  <p className="max-w-prose text-sm text-ink-soft">{cancel.blocked}</p>
                  {cancel.holdClaimStale && (
                    <ActionButton
                      action={clearHoldClaimAction.bind(null, rental.id)}
                      variant="outline"
                      size="sm"
                      confirmLabel={`Yes: PayPal shows no open hold for ${rental.id}-deposit`}
                      pendingLabel="Saving…"
                    >
                      I checked PayPal: no hold is open
                    </ActionButton>
                  )}
                </div>
              ) : (
                <CancelForm
                  rentalId={rental.id}
                  paid={cancel.paid}
                  policyCents={cancel.refundCents}
                  policyPercent={cancel.policy.percent}
                  feeLeftCents={cancel.feeLeftCents}
                  firstName={rental.customerName.split(" ")[0]}
                />
              )}
            </Card>
          )}

          {rental.status === "cancelled" && rental.cancelledAt && (
            <Card className="p-6">
              <h2 className="font-display text-2xl font-bold">Cancelled</h2>
              {rental.cancelReason && <p className="mt-1 text-sm text-muted">&ldquo;{rental.cancelReason}&rdquo;</p>}
              <CancellationReceipt rental={rental} refunds={view.refunds} fee={view.feeCapture} audience="staff" />
              <Refunds view={view} disputeOpen={disputeOpen} draft={draft} />
            </Card>
          )}

          {rental.status === "out" && checkout && (
            <Card className="space-y-5 p-6">
              <div>
                <h2 className="font-display text-2xl font-bold">Return</h2>
                <p className="mt-1 text-sm text-muted">Photograph it the same way as at pickup. Then compare.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Photo sha={checkout.photoSha} label="At pickup" />
                {checkin ? <Photo sha={checkin.photoSha} label="At return" /> : null}
              </div>
              {checkout.acknowledgedAt ? (
                <p className="flex items-center gap-2 text-sm text-released">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> The customer confirmed the pickup photo.
                </p>
              ) : (
                <p className="text-sm text-muted">The customer has not confirmed the pickup photo yet.</p>
              )}
              {checkin ? (
                <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-brand-soft p-4">
                  <ActionButton action={inspectAction.bind(null, rental.id)} variant="brand" size="lg" pendingLabel="Two independent looks are comparing…">
                    <Sparkles className="h-5 w-5" aria-hidden /> Compare the photos
                  </ActionButton>
                  <p className="max-w-sm text-sm text-ink-soft">Two separate AI looks run in parallel. Only what both see can be proposed as a charge.</p>
                </div>
              ) : (
                <PhotoCapture rentalId={rental.id} phase="checkin" shot={item.shot} samples={samplesFor(item.id, "checkin")} />
              )}
            </Card>
          )}

          {assessment && checkout && checkin && ["inspecting", "customer_review", "responded", "settled", "disputed"].includes(rental.status) && (
            <Card className="space-y-5 p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-2xl font-bold">
                    {rental.status === "inspecting" ? "What the photos show" : rental.status === "responded" ? "The customer answered" : "Findings"}
                  </h2>
                  <p className="mt-1 text-sm text-muted">{assessment.summary}</p>
                </div>
                <Badge tone="note">
                  {assessment.source === "live" ? `Gemini · ${assessment.model}` : assessment.source === "replay" ? "Recorded Gemini reply" : "No AI"}
                </Badge>
              </div>
              {!assessment.usable && <Notice tone="charged" title="The photos could not be compared">{assessment.issue}</Notice>}
              <InspectionView
                checkoutSha={checkout.photoSha}
                checkinSha={checkin.photoSha}
                findings={assessment.findings}
                mode={rental.status === "inspecting" ? "staff" : rental.status === "responded" ? "resolve" : "readonly"}
                rentalId={rental.id}
              />
              {rental.authorizedCents && plan && !settled && (
                <div className="rounded-2xl bg-paper p-4">
                  <MoneyBar state="proposed" authorizedCents={rental.authorizedCents} proposedCents={plan.totalCents} />
                </div>
              )}
              {rental.status === "inspecting" &&
                (kept.length === 0 ? (
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-released-soft p-4">
                    <ActionButton action={settleAction.bind(null, rental.id)} variant="released" size="lg" pendingLabel="Releasing on PayPal…">
                      Release the whole {formatUsd(rental.authorizedCents ?? 0)}
                    </ActionButton>
                    <p className="max-w-sm text-sm text-ink-soft">Nothing to charge. PayPal voids the hold and the customer sees it released right away.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-held-soft p-4">
                    <ActionButton action={sendToCustomerAction.bind(null, rental.id)} variant="primary" size="lg" pendingLabel="Sending…">
                      Send {kept.length} item{kept.length > 1 ? "s" : ""} to {rental.customerName.split(" ")[0]}
                    </ActionButton>
                    <p className="max-w-sm text-sm text-ink-soft">They see the photos and the prices on their phone and accept or question each one. Nothing is charged yet.</p>
                  </div>
                ))}
              {rental.status === "customer_review" && (
                <Notice tone="held" title={`Waiting for ${rental.customerName.split(" ")[0]}`}>
                  Their answers appear here the moment they send them. The QR code on the right opens their page.
                </Notice>
              )}
              {rental.status === "responded" && plan && (
                <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-paper p-4">
                  <ActionButton
                    action={settleAction.bind(null, rental.id)}
                    variant={plan.captureCents > 0 ? "charged" : "released"}
                    size="lg"
                    disabled={awaitingResolution(assessment.findings).length > 0}
                    pendingLabel="Settling on PayPal…"
                  >
                    {plan.totalCents > 0
                      ? `Keep ${formatUsd(plan.totalCents)}, release ${formatUsd(plan.releasedCents)}`
                      : `Release the whole ${formatUsd(rental.authorizedCents ?? 0)}`}
                  </ActionButton>
                  <p className="max-w-sm text-sm text-ink-soft">
                    {awaitingResolution(assessment.findings).length > 0
                      ? "Decide on each questioned item first."
                      : plan.extraCents > 0
                        ? `${formatUsd(plan.extraCents)} above the deposit goes to the saved PayPal wallet.`
                        : "One final capture; PayPal releases the rest of the hold."}
                  </p>
                </div>
              )}
            </Card>
          )}

          {settled && (
            <Card className="p-6">
              <h2 className="font-display text-2xl font-bold">Settled</h2>
              <div className="mt-4">
                <MoneyBar
                  state="settled"
                  size="lg"
                  authorizedCents={rental.authorizedCents ?? 0}
                  capturedCents={rental.capturedCents ?? 0}
                  releasedCents={rental.releasedCents ?? 0}
                  extraCents={rental.extraCents ?? 0}
                  refundedCents={view.refundedCents}
                />
              </div>
              <dl className="mt-5 grid gap-x-6 gap-y-1 font-mono text-xs text-muted sm:grid-cols-2">
                {rental.settlementCaptureId && (
                  <div>
                    <dt className="inline">capture </dt>
                    <dd className="inline">{rental.settlementCaptureId}</dd>
                  </div>
                )}
                {rental.extraCaptureId && (
                  <div>
                    <dt className="inline">extra capture </dt>
                    <dd className="inline">{rental.extraCaptureId}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline">authorization </dt>
                  <dd className="inline">{rental.authorizationId}</dd>
                </div>
              </dl>
              {desk?.dispute.outcome === "RESOLVED_BUYER_FAVOUR" && (
                <p className="mt-3 text-sm text-charged">After the dispute, PayPal refunded {formatUsd(desk.dispute.refundedCents ?? desk.dispute.amountCents ?? 0)} of this to the customer.</p>
              )}
              <Refunds view={view} disputeOpen={disputeOpen} draft={draft} />
              {!desk && (
                <div className="mt-5 flex flex-wrap items-start gap-3 border-t border-line pt-4">
                  {paypalMode === "demo" ? (
                    <ActionButton action={demoOpenDisputeAction.bind(null, rental.id)} variant="outline" size="sm" pendingLabel="Opening…">
                      Demo stand-in: the customer disputes this charge with PayPal
                    </ActionButton>
                  ) : (
                    <ActionButton action={findDisputesAction.bind(null, rental.id)} variant="outline" size="sm" pendingLabel="Asking PayPal…">
                      Check PayPal for disputes
                    </ActionButton>
                  )}
                  <p className="max-w-sm text-xs text-muted">
                    {paypalMode === "demo"
                      ? "In the sandbox or live, the customer opens a dispute in PayPal and it arrives here by webhook."
                      : "Disputes arrive here by webhook. Without one, this asks PayPal for disputes on this rental's payments."}
                  </p>
                </div>
              )}
            </Card>
          )}
        </div>

        <aside className="space-y-5">
          <Card className="p-5">
            <Eyebrow>Customer</Eyebrow>
            <p className="mt-2 font-semibold">{rental.customerName}</p>
            <p className="text-sm text-muted">{rental.customerEmail}</p>
            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{paid ? "Fee paid" : "Fee, not paid"}</dt>
                <dd className="tabular font-semibold">{formatUsd(rental.feeCents)}</dd>
              </div>
              {view.feeRefundedCents > 0 && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Fee refunded</dt>
                  <dd className="tabular font-semibold text-released">{formatUsd(view.feeRefundedCents)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-muted">PayPal saved</dt>
                <dd className="font-semibold">{rental.vaultId ? "Yes" : "No"}</dd>
              </div>
              {rental.payerEmail && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">PayPal account</dt>
                  <dd className="truncate">{rental.payerEmail}</dd>
                </div>
              )}
            </dl>
            <div className="mt-4 flex items-center gap-3">
              <Qr value={customerUrl} size={112} label="QR code for the customer's rental page" />
              <a href={customerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                Customer&apos;s page <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </div>
          </Card>

          <Card className="p-5">
            <Eyebrow>Deposit on PayPal</Eyebrow>
            {rental.authorizationId ? (
              <>
                <dl className="mt-2 space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">{settled ? "Was held" : "Held"}</dt>
                    <dd className="tabular font-semibold text-held-ink">{formatUsd(rental.authorizedCents ?? 0)}</dd>
                  </div>
                  {settled && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Kept</dt>
                        <dd className="tabular font-semibold text-charged">{formatUsd((rental.capturedCents ?? 0) + (rental.extraCents ?? 0))}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Released</dt>
                        <dd className="tabular font-semibold text-released">{formatUsd(rental.releasedCents ?? 0)}</dd>
                      </div>
                      {view.refundedCents > 0 && (
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted">Refunded since</dt>
                          <dd className="tabular font-semibold text-released">{formatUsd(view.refundedCents)}</dd>
                        </div>
                      )}
                    </>
                  )}
                  {rental.authorizationExpiresAt && !settled && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Hold expires</dt>
                      <dd>{shortDate(rental.authorizationExpiresAt)}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-1.5 space-y-1.5">
                  {rental.parentAuthorizationId ? (
                    <p className="pt-1 text-xs text-released">Hold renewed for a fresh 3-day honor period (was {rental.parentAuthorizationId}).</p>
                  ) : (
                    rental.authorizedAt &&
                    ["out", "inspecting", "customer_review", "responded"].includes(rental.status) && (
                      <p className="pt-1 text-xs text-muted">
                        Renews automatically on {shortDate(renewalDueAt(new Date(rental.authorizedAt), rental.endDate).toISOString())}, the day before it is
                        due back, so PayPal&apos;s honor period covers the return.
                      </p>
                    )
                  )}
                  <p className="break-all font-mono text-[11px] text-muted">authorization {rental.authorizationId}</p>
                </div>
              </>
            ) : rental.status === "cancelled" ? (
              <p className="mt-2 text-sm text-muted">None held: the booking was cancelled before pickup.</p>
            ) : (
              <p className="mt-2 text-sm text-muted">{formatUsd(rental.depositCents)} will be held at pickup.</p>
            )}
          </Card>

          <Card className="p-5">
            <Eyebrow>Audit trail</Eyebrow>
            <div className="mt-3">
              <Timeline events={view.events} intact={view.chainIntact} />
            </div>
          </Card>
        </aside>
      </main>
    </>
  );
}
