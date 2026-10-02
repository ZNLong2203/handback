import { ArrowLeft, CheckCircle2, ExternalLink, Sparkles } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { holdDepositAction, inspectAction, sendToCustomerAction, settleAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { ShopHeader } from "@/components/headers";
import { InspectionView } from "@/components/inspection-view";
import { LiveRefresh } from "@/components/live-refresh";
import { MoneyBar } from "@/components/money-bar";
import { PhotoCapture } from "@/components/photo-capture";
import { Qr } from "@/components/qr";
import { Timeline } from "@/components/timeline";
import { Badge, Card, Eyebrow, Notice, cx } from "@/components/ui";
import { shortDate } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import { samplesFor } from "@/lib/samples";
import { awaitingResolution } from "@/lib/rentals/settlement";
import { STATUS, STEPS, stepIndex } from "@/lib/rentals/status";
import { loadRentalView, type RentalView } from "@/lib/rentals/view";
import { appUrl } from "@/lib/shop";

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

export default async function RentalAtCounter(props: PageProps<"/shop/rentals/[id]">) {
  const { id } = await props.params;
  const view = await loadRentalView({ id });
  if (!view) notFound();
  const { rental, item, checkout, checkin, assessment, plan } = view;
  const status = STATUS[rental.status];
  const customerUrl = `${appUrl()}/r/${rental.token}`;
  const kept = assessment?.findings.filter((f) => f.decision !== "note" && f.price && f.staff === "keep") ?? [];

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
            <div className="mt-6">
              <Steps status={rental.status} />
            </div>
            <p className="mt-5 text-sm font-medium text-ink-soft">Next: {status.staffNext}.</p>
          </Card>

          {rental.status === "booked" && (
            <Card className="space-y-5 p-6">
              <div>
                <h2 className="font-display text-2xl font-bold">Pickup</h2>
                <p className="mt-1 text-sm text-muted">Photograph the item with the customer at the counter, then hold the deposit.</p>
              </div>
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

          {assessment && checkout && checkin && ["inspecting", "customer_review", "responded", "settled"].includes(rental.status) && (
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
              {rental.authorizedCents && plan && rental.status !== "settled" && (
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

          {rental.status === "settled" && (
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
                <dt className="text-muted">Fee paid</dt>
                <dd className="tabular font-semibold">{formatUsd(rental.feeCents)}</dd>
              </div>
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
              <dl className="mt-2 space-y-1.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">{rental.status === "settled" ? "Was held" : "Held"}</dt>
                  <dd className="tabular font-semibold text-held">{formatUsd(rental.authorizedCents ?? 0)}</dd>
                </div>
                {rental.status === "settled" && (
                  <>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Kept</dt>
                      <dd className="tabular font-semibold text-charged">{formatUsd((rental.capturedCents ?? 0) + (rental.extraCents ?? 0))}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Released</dt>
                      <dd className="tabular font-semibold text-released">{formatUsd(rental.releasedCents ?? 0)}</dd>
                    </div>
                  </>
                )}
                {rental.authorizationExpiresAt && rental.status !== "settled" && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Hold expires</dt>
                    <dd>{shortDate(rental.authorizationExpiresAt)}</dd>
                  </div>
                )}
                <div className="break-all font-mono text-[11px] text-muted">authorization {rental.authorizationId}</div>
              </dl>
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
