"use client";

import { Ban, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { cancelAtCounterAction } from "@/app/actions";
import { formatUsd, parseUsdInput } from "@/lib/money";
import { Button } from "./ui";

/**
 * The counter cancels a booking before pickup. The refund starts at what the
 * cancellation policy gives the renter now, and staff may change it to
 * anything from $0.00 up to what is left of the fee. The first press asks;
 * the second cancels. Pressing twice cancels and refunds once.
 */
export function CancelForm({
  rentalId,
  paid,
  policyCents,
  policyPercent,
  feeLeftCents,
  firstName,
}: {
  rentalId: string;
  paid: boolean;
  policyCents: number;
  policyPercent: number;
  feeLeftCents: number;
  firstName: string;
}) {
  const [amount, setAmount] = useState(paid ? (policyCents / 100).toFixed(2) : "0");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cents = parseUsdInput(amount);
  const valid = cents !== null && cents <= feeLeftCents && reason.trim().length > 0;

  const send = () =>
    startTransition(async () => {
      setError(null);
      setAsking(false);
      const res = await cancelAtCounterAction(rentalId, { amount, reason });
      if (!res.ok) setError(res.error);
      else if (typeof res.data === "string") setStatus(res.data);
    });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (asking) send();
        else setAsking(true);
      }}
    >
      <div className={paid ? "grid gap-3 sm:grid-cols-[9rem_1fr]" : ""}>
        {paid && (
          <label className="text-sm">
            <span className="block font-semibold">Refund</span>
            <span className="mt-1 flex h-11 items-center rounded-xl border border-line-strong bg-card px-3 focus-within:border-ink/50">
              <span className="text-muted">$</span>
              <input
                name="refund"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => (setAmount(e.target.value), setAsking(false))}
                className="tabular w-full bg-transparent pl-1 outline-none"
              />
            </span>
          </label>
        )}
        <label className="text-sm">
          <span className="block font-semibold">Reason {firstName} sees</span>
          <input
            name="reason"
            maxLength={200}
            autoComplete="off"
            placeholder="The kit failed its check before your rental"
            value={reason}
            onChange={(e) => (setReason(e.target.value), setAsking(false))}
            className="mt-1 h-11 w-full rounded-xl border border-line-strong bg-card px-3 outline-none focus:border-ink/50"
          />
        </label>
      </div>
      <p className="text-xs text-muted">
        {paid
          ? `The cancellation policy gives ${firstName} ${formatUsd(policyCents)} (${policyPercent}%) now. You can refund anything from $0.00 up to the ${formatUsd(feeLeftCents)} left of the fee; PayPal sends it back the way they paid.`
          : "Nothing was paid, so nothing is refunded and PayPal is not called."}{" "}
        The unit goes back on the schedule.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={pending || !valid}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Ban className="h-4 w-4" aria-hidden />}
          {pending
            ? "Cancelling…"
            : asking
              ? cents
                ? `Yes, cancel and refund ${formatUsd(cents)}`
                : "Yes, cancel with no refund"
              : "Cancel booking"}
        </Button>
        {asking && !pending && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>
            Keep it
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-prose text-sm font-medium text-charged">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="max-w-prose text-sm text-ink-soft">
          {status}
        </p>
      )}
    </form>
  );
}
