import { shortDate } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import { isRefunded, type StoredRefund } from "@/lib/rentals/refunds";
import type { Rental } from "@/lib/rentals/types";

/** One refund of the fee, in words: what PayPal has done with it. */
function refundState(r: StoredRefund, renter: boolean): string {
  if (r.state === "requested") return "sent to PayPal; its answer has not arrived yet";
  if (r.state === "refused") return renter ? "PayPal refused it; the shop sees this and can send it again" : "PayPal refused it";
  if (r.paypalStatus === "PENDING") return "PayPal is processing it";
  if (r.paypalStatus === "FAILED" || r.paypalStatus === "CANCELLED") return `PayPal reports it ${r.paypalStatus.toLowerCase()}`;
  return "refunded on PayPal";
}

/**
 * The money of a cancelled booking, for the renter's page and the counter:
 * the fee paid, each refund of it and where PayPal is with it, and what the
 * shop keeps. No deposit is ever held before pickup.
 */
export function CancellationReceipt({ rental, refunds, audience }: { rental: Rental; refunds: StoredRefund[]; audience: "renter" | "staff" }) {
  const renter = audience === "renter";
  const paid = rental.feeCaptureId !== null && rental.cancelledAt !== null;
  const fee = refunds.filter((r) => r.captureId === rental.feeCaptureId && r.state !== "refused");
  const refused = refunds.filter((r) => r.captureId === rental.feeCaptureId && r.state === "refused");
  const back = fee.filter(isRefunded).reduce((s, r) => s + r.amountCents, 0);
  const onTheWay = fee.filter((r) => r.state === "requested").reduce((s, r) => s + r.amountCents, 0);
  if (!paid) {
    return <p className="mt-3 text-sm text-ink-soft">{renter ? "Nothing was paid, so nothing was charged." : "The fee was never paid; nothing was charged."}</p>;
  }
  return (
    <dl className="mt-4 space-y-2 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-muted">Rental fee {renter ? "you paid" : "paid"} at booking</dt>
        <dd className="tabular font-semibold">{formatUsd(rental.feeCents)}</dd>
      </div>
      {[...fee, ...refused].map((r) => (
        <div key={r.id} className="flex justify-between gap-3">
          <dt className="text-muted">
            {r.seq === null ? "Refunded outside the app" : `Refund ${r.seq}`}: {refundState(r, renter)}
          </dt>
          <dd className={r.state === "refused" ? "tabular text-muted line-through" : "tabular font-semibold text-released"}>−{formatUsd(r.amountCents)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-line pt-2">
        <dt className="font-semibold">{renter ? "The shop keeps" : "Kept of the fee"}</dt>
        <dd className="tabular font-bold">{formatUsd(rental.feeCents - back - onTheWay)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted">Deposit</dt>
        <dd>None held: cancelled before pickup</dd>
      </div>
      <p className="pt-1 text-xs text-muted">
        Cancelled {shortDate(rental.cancelledAt!)}.{" "}
        {renter ? "PayPal sends a refund back the way you paid. If a card funds your PayPal, your card issuer decides when it shows." : null}
      </p>
    </dl>
  );
}
