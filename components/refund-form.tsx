"use client";

import { Loader2, Undo2 } from "lucide-react";
import { useState, useTransition } from "react";
import { refundAction } from "@/app/actions";
import { formatUsd, parseUsdInput } from "@/lib/money";
import { Button } from "./ui";

type Capture = { captureId: string; label: string; capturedCents: number; leftCents: number };

/**
 * Refund part or all of what the settlement took. The form carries the
 * refund number the server expects next, so pressing twice, or sending again
 * after a lost reply, refunds once. The first press asks; the second sends.
 */
export function RefundForm({ rentalId, captures, seq, firstName }: { rentalId: string; captures: Capture[]; seq: number; firstName: string }) {
  const open = captures.filter((c) => c.leftCents > 0);
  const [captureId, setCaptureId] = useState(open[0]?.captureId ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const capture = open.find((c) => c.captureId === captureId) ?? open[0];
  const cents = parseUsdInput(amount);
  if (!capture) return null;

  const send = () =>
    startTransition(async () => {
      setError(null);
      setDone(null);
      setAsking(false);
      const res = await refundAction(rentalId, { captureId: capture.captureId, amount, reason, seq });
      if (!res.ok) setError(res.error);
      else {
        setDone(`Refunded ${formatUsd(cents ?? 0)}. PayPal sends it back to ${firstName}'s PayPal account.`);
        setAmount("");
        setReason("");
      }
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
      {open.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold">Which charge</legend>
          {open.map((c) => (
            <label key={c.captureId} className="flex items-center gap-2 text-sm">
              <input type="radio" name="capture" checked={c.captureId === capture.captureId} onChange={() => (setCaptureId(c.captureId), setAsking(false))} />
              <span>
                {c.label[0].toUpperCase() + c.label.slice(1)}: {formatUsd(c.leftCents)} left of {formatUsd(c.capturedCents)}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
        <label className="text-sm">
          <span className="block font-semibold">Amount</span>
          <span className="mt-1 flex h-11 items-center rounded-xl border border-line-strong bg-card px-3 focus-within:border-ink/50">
            <span className="text-muted">$</span>
            <input
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder={(capture.leftCents / 100).toFixed(2)}
              value={amount}
              onChange={(e) => (setAmount(e.target.value), setAsking(false))}
              className="tabular w-full bg-transparent pl-1 outline-none"
            />
          </span>
        </label>
        <label className="text-sm">
          <span className="block font-semibold">Reason {firstName} sees</span>
          <input
            name="reason"
            maxLength={200}
            autoComplete="off"
            placeholder="The lens hood turned up in the case"
            value={reason}
            onChange={(e) => (setReason(e.target.value), setAsking(false))}
            className="mt-1 h-11 w-full rounded-xl border border-line-strong bg-card px-3 outline-none focus:border-ink/50"
          />
        </label>
      </div>
      <p className="text-xs text-muted">
        At most {formatUsd(capture.leftCents)} is left to refund on {capture.label}. The reason is shown on {firstName}&apos;s page and in PayPal&apos;s email.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={pending || cents === null || cents <= 0 || !reason.trim()}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />}
          {pending ? "Refunding on PayPal…" : asking ? `Yes, refund ${formatUsd(cents ?? 0)} to ${firstName}` : `Refund ${cents ? formatUsd(cents) : ""}`.trim()}
        </Button>
        {asking && !pending && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-prose text-sm font-medium text-charged">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="max-w-prose text-sm text-released">
          {done}
        </p>
      )}
    </form>
  );
}
