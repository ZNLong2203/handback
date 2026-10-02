import { ExternalLink, FileText, FlaskConical, RefreshCw, Scale } from "lucide-react";
import {
  acceptClaimAction,
  makeOfferAction,
  prepareEvidenceAction,
  refreshDisputeAction,
  sandboxDecideAction,
  sandboxRequireEvidenceAction,
  submitEvidenceAction,
} from "@/app/actions";
import { shortDate } from "@/lib/dates";
import { reasonLabel, utc } from "@/lib/disputes/facts";
import { disputeStatusLabel, evidenceLabel, OUTCOME_REASON_LABEL, STAGE_LABEL } from "@/lib/disputes/labels";
import { DISPUTE_FEES } from "@/lib/disputes/recommend";
import type { DisputeDesk } from "@/lib/disputes/service";
import { formatUsd } from "@/lib/money";
import type { Rental } from "@/lib/rentals/types";
import { ActionButton } from "./action-button";
import { Badge, Card, Eyebrow, Notice } from "./ui";

function captureName(rental: Rental, transactionId: string | null): string {
  if (!transactionId) return "a payment";
  if (transactionId === rental.settlementCaptureId) return `the ${formatUsd(rental.capturedCents ?? 0)} damage capture`;
  if (transactionId === rental.feeCaptureId) return `the ${formatUsd(rental.feeCents)} rental fee`;
  if (transactionId === rental.extraCaptureId) return `the ${formatUsd(rental.extraCents ?? 0)} charge above the deposit`;
  return "a payment";
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The counter's view of a PayPal dispute: what PayPal says, what the record
 * can prove, what each answer costs, and only the actions PayPal offers on
 * the dispute right now.
 */
export function DisputePanel({ desk, rental }: { desk: DisputeDesk; rental: Rental }) {
  const { dispute: d, actions, recommendation: rec, pack } = desk;
  const status = disputeStatusLabel(d.status, d.outcome);
  const resolved = d.status === "RESOLVED";
  const canOffer = Boolean(rec.offerCents && actions.makeOffer?.includes("REFUND"));
  const sandbox = desk.mode !== "live";
  const amount = d.amountCents ?? 0;

  return (
    <Card className="space-y-5 p-6" aria-labelledby="dispute-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow>PayPal dispute · {d.id}</Eyebrow>
          <h2 id="dispute-heading" className="mt-1 font-display text-2xl font-bold">
            {sentence(reasonLabel(d.reason))}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {formatUsd(amount)} of {captureName(rental, d.transactionId)}
            {d.openedAt ? `, opened ${utc(d.openedAt)}` : ""}.
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Stage</dt>
          <dd className="font-medium">{(d.stage && STAGE_LABEL[d.stage]) ?? d.stage ?? "Not reported yet"}</dd>
        </div>
        <div>
          <dt className="text-muted">Answer by</dt>
          <dd className="font-medium">
            {d.sellerResponseDueAt ? `${shortDate(d.sellerResponseDueAt)} (${desk.daysLeft} day${desk.daysLeft === 1 ? "" : "s"} left)` : resolved ? "Closed" : "No deadline right now"}
          </dd>
        </div>
        {desk.customerNote && (
          <div className="sm:col-span-2">
            <dt className="text-muted">The customer wrote to PayPal</dt>
            <dd className="mt-0.5 italic text-ink-soft">&ldquo;{desk.customerNote}&rdquo;</dd>
          </div>
        )}
        {desk.requested.length > 0 && !resolved && (
          <div className="sm:col-span-2">
            <dt className="text-muted">PayPal asked the shop for</dt>
            <dd className="font-medium">{desk.requested.map(evidenceLabel).join(", ")}</dd>
          </div>
        )}
        {desk.hold && (
          <div className="sm:col-span-2">
            <dt className="text-muted">Money on hold</dt>
            <dd className="font-medium">
              PayPal held {formatUsd(desk.hold.cents)} of the shop&apos;s balance
              {desk.hold.placedAt ? ` on ${utc(desk.hold.placedAt)}` : ""}
              {desk.hold.releasedAt ? ` and released it on ${utc(desk.hold.releasedAt)}` : " while it decides"}.
            </dd>
          </div>
        )}
      </dl>

      {resolved && (
        <Notice tone={d.outcome === "RESOLVED_SELLER_FAVOUR" ? "released" : "charged"} title={status.label}>
          {d.outcome === "RESOLVED_BUYER_FAVOUR"
            ? `PayPal refunded ${formatUsd(d.refundedCents ?? amount)} to the customer.`
            : d.outcome === "RESOLVED_SELLER_FAVOUR"
              ? "The shop keeps the charge."
              : "PayPal closed the case."}
          {d.paypal.dispute_outcome?.outcome_reason ? ` PayPal's reason: ${OUTCOME_REASON_LABEL[d.paypal.dispute_outcome.outcome_reason] ?? d.paypal.dispute_outcome.outcome_reason.toLowerCase().replace(/_/g, " ")}.` : ""}
        </Notice>
      )}

      {!resolved && (
        <section className="rounded-2xl bg-brand-soft p-4" aria-label="Recommendation">
          <p className="flex items-center gap-2 font-semibold text-brand-ink">
            <Scale className="h-4 w-4" aria-hidden /> {rec.headline}
          </p>
          {rec.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {rec.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">Answer</th>
                  <th className="py-1 pr-3 font-semibold">If</th>
                  <th className="py-1 pr-3 text-right font-semibold">Refund</th>
                  <th className="py-1 text-right font-semibold">PayPal fee</th>
                </tr>
              </thead>
              <tbody>
                {rec.options.flatMap((o) =>
                  o.outcomes.map((out, i) => (
                    <tr key={`${o.action}-${i}`} className={o.available ? "" : "text-muted"}>
                      <td className="py-1 pr-3 align-top">{i === 0 ? `${o.label}${o.available ? "" : " (not offered now)"}` : ""}</td>
                      <td className="py-1 pr-3 align-top">{out.when}</td>
                      <td className="tabular py-1 pr-3 text-right align-top">{formatUsd(out.refundCents)}</td>
                      <td className="tabular py-1 text-right align-top">{formatUsd(out.feeCents)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            {rec.fee.why} Fees from{" "}
            <a className="underline" href={DISPUTE_FEES.feesSource.url} target="_blank" rel="noreferrer">
              {DISPUTE_FEES.feesSource.title}
            </a>{" "}
            and{" "}
            <a className="underline" href={DISPUTE_FEES.rulesSource.url} target="_blank" rel="noreferrer">
              {DISPUTE_FEES.rulesSource.title}
            </a>
            , assuming the Standard fee (shops with a 1.5% dispute rate and over 100 sales pay {formatUsd(DISPUTE_FEES.highVolumeCents)}). Costs per outcome, not odds.
          </p>
        </section>
      )}

      <section className="space-y-3" aria-label="Evidence pack">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold">
            <FileText className="h-4 w-4" aria-hidden /> Evidence pack
          </h3>
          {pack && (
            <a href={`/api/evidence/${pack.sha256}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
              Open the PDF <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>
        {pack ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-soft">
              One page built from this rental&apos;s record as of {utc(pack.facts.asOf)}: both photos with their SHA-256, the findings, the customer&apos;s answers, the
              settlement and the audit chain. Summary {pack.narrative.source === "gemini" ? `by ${pack.narrative.model}, checked against the pack's facts` : "from fixed sentences"}.
            </p>
            <p className="break-all font-mono text-[11px] text-muted">sha256 {pack.sha256}</p>
            {!pack.current && actions.provideEvidence && (
              <p className="text-sm text-held">The record has changed since this pack was made. Sending builds a fresh one; rebuild first to look at it.</p>
            )}
            <iframe src={`/api/evidence/${pack.sha256}`} title="Evidence pack preview" className="hidden h-[34rem] w-full rounded-xl border border-line md:block" />
          </div>
        ) : (
          <p className="text-sm text-muted">Not prepared yet. It is built only from what was recorded during the rental; nothing is typed in for the dispute.</p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          {(!pack || (!pack.current && actions.provideEvidence)) && (
            <ActionButton action={prepareEvidenceAction.bind(null, rental.id)} variant={actions.provideEvidence ? "outline" : "primary"} pendingLabel="Building the pack…">
              {pack ? "Rebuild from the latest record" : "Prepare the evidence pack"}
            </ActionButton>
          )}
          {actions.provideEvidence && (
            <ActionButton action={submitEvidenceAction.bind(null, rental.id)} variant="brand" confirmLabel="Send the pack and both photos to PayPal" pendingLabel="Sending to PayPal…">
              Send to PayPal
            </ActionButton>
          )}
        </div>
        {desk.sent.length > 0 && (
          <ul className="space-y-1 text-sm">
            {desk.sent.map((s) => (
              <li key={`${s.sha256}-${s.at}`} className="text-ink-soft">
                Sent {utc(s.at)} as {s.evidenceType.toLowerCase().replace(/_/g, " ")}: {s.files.join(", ")}{" "}
                <a className="font-mono text-[11px] text-brand hover:underline" href={`/api/evidence/${s.sha256}`} target="_blank" rel="noreferrer">
                  {s.sha256.slice(0, 12)}…
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(canOffer || actions.acceptClaim) && !resolved && (
        <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
          {canOffer && (
            <ActionButton action={makeOfferAction.bind(null, rental.id, rec.offerCents!)} variant="outline" confirmLabel={`Offer ${formatUsd(rec.offerCents!)} through PayPal`} pendingLabel="Sending the offer…">
              Offer {formatUsd(rec.offerCents!)}
            </ActionButton>
          )}
          {actions.acceptClaim && (
            <ActionButton action={acceptClaimAction.bind(null, rental.id)} variant="outline" confirmLabel={`Refund ${formatUsd(amount)} and close the case`} pendingLabel="Telling PayPal…">
              Accept the claim
            </ActionButton>
          )}
        </div>
      )}

      {sandbox && !resolved && (
        <section className="rounded-2xl border border-dashed border-line-strong p-4" aria-label={desk.mode === "sandbox" ? "Sandbox only" : "Demo stand-in"}>
          <p className="flex items-center gap-2 font-semibold">
            <FlaskConical className="h-4 w-4" aria-hidden /> {desk.mode === "sandbox" ? "Sandbox only: play PayPal's part" : "Demo stand-in: play PayPal's part"}
          </p>
          <p className="mt-1 text-sm text-muted">
            In live PayPal, PayPal&apos;s own agents ask for evidence and decide. {desk.mode === "sandbox" ? "The sandbox" : "The demo stand-in, like the sandbox,"} lets the shop trigger
            those steps to test a whole case. They only appear when PayPal offers them on this dispute.
          </p>
          {actions.requireEvidence || actions.adjudicate ? (
            <div className="mt-3 flex flex-wrap items-start gap-3">
              {actions.requireEvidence && (
                <ActionButton action={sandboxRequireEvidenceAction.bind(null, rental.id)} variant="outline" size="sm" pendingLabel="Asking…">
                  PayPal asks the shop for evidence
                </ActionButton>
              )}
              {actions.adjudicate && (
                <>
                  <ActionButton action={sandboxDecideAction.bind(null, rental.id, "SELLER_FAVOR")} variant="outline" size="sm" pendingLabel="Deciding…">
                    PayPal decides for the shop
                  </ActionButton>
                  <ActionButton action={sandboxDecideAction.bind(null, rental.id, "BUYER_FAVOR")} variant="outline" size="sm" pendingLabel="Deciding…">
                    PayPal decides for the customer
                  </ActionButton>
                </>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              Nothing to play right now. {desk.mode === "sandbox" ? "In our sandbox runs PayPal offered these about two to three minutes after it received evidence; refresh to check." : "These appear once PayPal is reviewing the case."}
            </p>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4 text-xs text-muted">
        <span>Last read from PayPal {utc(d.syncedAt)}.</span>
        {desk.mode !== "demo" && (
          <ActionButton action={refreshDisputeAction.bind(null, rental.id)} variant="ghost" size="sm" pendingLabel="Reading PayPal…">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh from PayPal
          </ActionButton>
        )}
      </div>
    </Card>
  );
}
