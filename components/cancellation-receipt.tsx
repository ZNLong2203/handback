import { shortDate } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import type { RefundableCapture, StoredRefund } from "@/lib/rentals/refunds";
import type { Rental } from "@/lib/rentals/types";

/** One refund of the fee, in words: what PayPal has done with it. */
function refundState(r: StoredRefund, renter: boolean): string {
  if (r.state === "requested") return "sent to PayPal; its answer has not arrived yet";
  if (r.state === "refused") return renter ? "PayPal refused it; the shop sees this and can send it again" : "PayPal refused it";
  if (r.paypalStatus === "PENDING") return "PayPal is processing it";
  if (r.paypalStatus === "FAILED" || r.paypalStatus === "CANCELLED") return `PayPal reports it ${r.paypalStatus.toLowerCase()}`;
  return "refunded on PayPal";
}

const counts = (r: StoredRefund) => r.state !== "refused" && r.paypalStatus !== "FAILED" && r.paypalStatus !== "CANCELLED";

/**
 * The money of a cancelled booking, for the renter's page and the counter:
 * the fee paid, each refund of it and where PayPal is with it, money a
 * dispute gave back, and what the shop keeps, counted the way the refund
 * code counts what is left on the fee's capture (refundableCaptures), so it
 * never goes below zero. No deposit is ever held before pickup.
 */
export function CancellationReceipt({
  rental,
  refunds,
  fee,
  audience,
}: {
  rental: Rental;
  refunds: StoredRefund[];
  fee: RefundableCapture | null;
  audience: "renter" | "staff";
}) {
  const renter = audience === "renter";
  if (!fee || !rental.cancelledAt) {
    return <p className="mt-3 text-sm text-ink-soft">{renter ? "Nothing was paid, so nothing was charged." : "The fee was never paid; nothing was charged."}</p>;
  }
  const onFee = refunds.filter((r) => r.captureId === fee.captureId);
  return (
    <dl className="mt-4 space-y-2 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-muted">Rental fee {renter ? "you paid" : "paid"} at booking</dt>
        <dd className="tabular font-semibold">{formatUsd(fee.capturedCents)}</dd>
      </div>
      {onFee.map((r) => (
        <div key={r.id} className="flex justify-between gap-3">
          <dt className="text-muted">
            {r.seq === null ? "Refunded outside the app" : `Refund ${r.seq}`}: {refundState(r, renter)}
          </dt>
          <dd className={counts(r) ? "tabular font-semibold text-released" : "tabular text-muted line-through"}>−{formatUsd(r.amountCents)}</dd>
        </div>
      ))}
      {fee.disputeCents > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Returned through the PayPal dispute</dt>
          <dd className="tabular font-semibold text-released">−{formatUsd(fee.disputeCents)}</dd>
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-line pt-2">
        <dt className="font-semibold">{renter ? "The shop keeps" : "Kept of the fee"}</dt>
        <dd className="tabular font-bold">{formatUsd(fee.leftCents)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted">Deposit</dt>
        <dd>None held: cancelled before pickup</dd>
      </div>
      <p className="pt-1 text-xs text-muted">
        Cancelled {shortDate(rental.cancelledAt)}.{" "}
        {renter ? "PayPal sends a refund back the way you paid. If a card funds your PayPal, your card issuer decides when it shows." : null}
      </p>
    </dl>
  );
}
