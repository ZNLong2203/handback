"use client";

import {
  INSTANCE_LOADING_STATE,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  usePayPal,
  type OnApproveDataOneTimePayments,
  type OnErrorData,
} from "@paypal/react-paypal-js/sdk-v6";
import { Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { confirmBookingAction, startBookingAction } from "@/app/actions";
import { addDaysIso, rentalDays } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import { Button, cx } from "./ui";

type Props = {
  itemId: string;
  dailyCents: number;
  depositCents: number;
  maxDays: number;
  /** The last pickup date that can be booked. */
  lastPickup: string;
  today: string;
  /** The dates the form starts on; today to three days later when not given. */
  initial?: { start: string; end: string };
  paypal: { clientId: string; environment: "sandbox" | "production" } | null;
};

function useBooking({ itemId, dailyCents, maxDays, lastPickup, today, initial }: Props) {
  const [start, setStart] = useState(initial?.start ?? today);
  const [end, setEnd] = useState(initial?.end ?? addDaysIso(today, 3));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const days = useMemo(() => {
    try {
      return rentalDays(start, end);
    } catch {
      return 0;
    }
  }, [start, end]);
  const problem =
    days === 0 || end <= start
      ? "The return date must be after the pickup date."
      : days > maxDays
        ? `Rentals can be at most ${maxDays} days.`
        : start > lastPickup
          ? `Bookings open up to ${lastPickup}; pick an earlier pickup date.`
        : !name.trim()
          ? "Enter your name."
          : !/^\S+@\S+\.\S+$/.test(email)
            ? "Enter your email."
            : null;
  return {
    fields: { start, setStart, end, setEnd, name, setName, email, setEmail },
    days,
    feeCents: days * dailyCents,
    problem,
    input: { itemId, name, email, startDate: start, endDate: end },
  };
}

export function BookingForm(props: Props) {
  const b = useBooking(props);
  const { fields: f } = b;
  const field = "mt-1 w-full rounded-xl border border-line-strong bg-paper px-3 py-2.5 text-ink";
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Pickup
          <input type="date" className={field} min={props.today} max={props.lastPickup} value={f.start} onChange={(e) => f.setStart(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Return
          <input type="date" className={field} min={f.start} value={f.end} onChange={(e) => f.setEnd(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Your name
          <input className={field} value={f.name} autoComplete="name" onChange={(e) => f.setName(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Email
          <input type="email" className={field} value={f.email} autoComplete="email" onChange={(e) => f.setEmail(e.target.value)} />
        </label>
      </div>

      <dl className="space-y-2 rounded-2xl bg-paper p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">
            {b.days || "–"} day{b.days === 1 ? "" : "s"} × {formatUsd(props.dailyCents)}
          </dt>
          <dd className="tabular font-semibold">{formatUsd(b.feeCents)}</dd>
        </div>
        <div className="flex justify-between border-t border-line pt-2 text-base">
          <dt className="font-semibold">Pay today</dt>
          <dd className="tabular font-bold">{formatUsd(b.feeCents)}</dd>
        </div>
        <div className="flex justify-between text-held-ink">
          <dt>Deposit, held at pickup (not charged)</dt>
          <dd className="tabular font-semibold">{formatUsd(props.depositCents)}</dd>
        </div>
      </dl>

      {props.paypal ? <PayPalPay {...props} booking={b} /> : <DemoPay booking={b} />}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-released" aria-hidden />
        By paying you agree to the deposit mandate: at pickup the shop may hold up to the deposit on this PayPal account, and it can charge only
        prices from the list on this page, after showing you each charge with the photos. You accept or question each one; a person at the shop
        decides the ones you question. Anything above the deposit is charged to the same account, and the rest is released when the shop settles.
        Cancelling before pickup refunds the fee as this page says. Your rental page shows the full mandate.
      </p>
    </div>
  );
}

type Booking = ReturnType<typeof useBooking>;

function useFinish() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return {
    error,
    setError,
    pending,
    finish: (orderId: string) =>
      startTransition(async () => {
        const res = await confirmBookingAction(orderId);
        if (res.ok) router.push(`/r/${res.data.token}`);
        else setError(res.error);
      }),
  };
}

function PayPalPay({ paypal, booking }: Props & { booking: Booking }) {
  return (
    <PayPalProvider
      clientId={paypal!.clientId}
      environment={paypal!.environment}
      components={["paypal-payments"]}
      pageType="checkout"
      testBuyerCountry="US"
    >
      <PayPalButtonArea booking={booking} />
    </PayPalProvider>
  );
}

function PayPalButtonArea({ booking }: { booking: Booking }) {
  const { loadingStatus } = usePayPal();
  const { error, setError, pending, finish } = useFinish();

  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED) {
    return <p className="text-sm text-charged">PayPal could not load. Check your connection and refresh the page.</p>;
  }
  return (
    <div className="space-y-2">
      {loadingStatus === INSTANCE_LOADING_STATE.PENDING || pending ? (
        <div className="flex h-12 items-center justify-center gap-2 rounded-full bg-paper text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {pending ? "Confirming your booking…" : "Loading PayPal…"}
        </div>
      ) : (
        // The button dims itself when disabled; the wrapper only stops clicks.
        <div className={cx(booking.problem && "pointer-events-none")} aria-disabled={Boolean(booking.problem)}>
          <PayPalOneTimePaymentButton
            type="pay"
            disabled={Boolean(booking.problem)}
            presentationMode="auto"
            savePayment
            createOrder={async () => {
              setError(null);
              const res = await startBookingAction(booking.input);
              if (!res.ok) {
                setError(res.error);
                throw new Error(res.error);
              }
              return { orderId: res.data.orderId };
            }}
            onApprove={async (data: OnApproveDataOneTimePayments) => finish(data.orderId)}
            onCancel={() => setError("You closed PayPal before paying. Nothing was charged.")}
            onError={(err: OnErrorData) => setError(err.message ? `PayPal: ${err.message}` : "PayPal could not finish. Nothing was charged.")}
          />
        </div>
      )}
      {booking.problem && <p className="text-sm text-muted">{booking.problem}</p>}
      {error && (
        <p role="alert" className="text-sm font-medium text-charged">
          {error}
        </p>
      )}
    </div>
  );
}

/** Without PayPal credentials the app runs against the stand-in, with an honest label. */
function DemoPay({ booking }: { booking: Booking }) {
  const { error, setError, pending, finish } = useFinish();
  const [starting, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      <Button
        variant="brand"
        size="lg"
        className="w-full"
        disabled={Boolean(booking.problem) || pending || starting}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await startBookingAction(booking.input);
            if (res.ok) finish(res.data.orderId);
            else setError(res.error);
          })
        }
      >
        {pending || starting ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        Pay {formatUsd(booking.feeCents)} (demo PayPal)
      </Button>
      {booking.problem && <p className="text-sm text-muted">{booking.problem}</p>}
      <p className="text-xs text-muted">Demo mode: no PayPal keys are set, so a stand-in that follows PayPal&apos;s sandbox rules approves the payment.</p>
      {error && (
        <p role="alert" className="text-sm font-medium text-charged">
          {error}
        </p>
      )}
    </div>
  );
}
