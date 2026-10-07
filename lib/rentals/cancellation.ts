import { shortDate } from "@/lib/dates";
import { formatUsd, type Cents } from "@/lib/money";
import { CANCELLATION_POLICY, type CancellationPolicy } from "@/lib/shop";

// The cancellation policy as plain arithmetic, with no database or PayPal:
// the booking page, the mandate, the renter's page and the cancel service all
// read it from here.

const HOUR_MS = 3_600_000;

/**
 * The policy fixed to one booking's dates: the share of the fee refunded when
 * the renter cancels before each moment (ISO instants, earliest first). From
 * the last one on, which is the start of the pickup day, nothing is refunded.
 * This is what a booking's deposit mandate records.
 */
export type CancellationTerms = { feeRefund: { before: string; percent: number }[] };

/** The start of the pickup day: dates are whole UTC days. */
export const pickupStarts = (pickupDate: string) => `${pickupDate}T00:00:00.000Z`;

export function cancellationTerms(pickupDate: string, policy: CancellationPolicy = CANCELLATION_POLICY): CancellationTerms {
  const start = Date.parse(pickupStarts(pickupDate));
  return {
    feeRefund: [...policy.feeRefund]
      .sort((a, b) => b.hoursBefore - a.hoursBefore)
      .map((t) => ({ before: new Date(start - t.hoursBefore * HOUR_MS).toISOString(), percent: t.percent })),
  };
}

export type CancellationRefund = {
  percent: number;
  /** The share of the fee, rounded down to a whole cent. */
  refundCents: Cents;
  /** Until when this share applies; null once nothing is refunded any more. */
  until: string | null;
};

/** What a renter who cancels at `now` gets back of `feeCents`. */
export function cancellationRefund(feeCents: Cents, terms: CancellationTerms, now: Date): CancellationRefund {
  const tier = terms.feeRefund.find((t) => now.getTime() < Date.parse(t.before));
  if (!tier) return { percent: 0, refundCents: 0, until: null };
  return { percent: tier.percent, refundCents: Math.floor((feeCents * tier.percent) / 100), until: tier.before };
}

const share = (percent: number) => (percent === 100 ? "the whole rental fee" : percent === 50 ? "half the rental fee" : `${percent}% of the rental fee`);
const when = (iso: string) => `${shortDate(iso)}, ${iso.slice(11, 16)} UTC`;
const shareOf = (percent: number, feeCents?: Cents) => (feeCents === undefined ? share(percent) : `${share(percent)} (${formatUsd(Math.floor((feeCents * percent) / 100))})`);

/** The policy in words, before dates are chosen (the booking page). */
export function policySentences(policy: CancellationPolicy = CANCELLATION_POLICY): string[] {
  const tiers = [...policy.feeRefund].sort((a, b) => b.hoursBefore - a.hoursBefore);
  return [
    ...tiers.map((t, i) =>
      t.hoursBefore > 0
        ? `Cancel at least ${t.hoursBefore} hours before the pickup day starts (00:00 UTC) and you get back ${share(t.percent)}.`
        : `Cancel ${i > 0 ? "later, but " : ""}before the pickup day starts and you get back ${share(t.percent)}.`,
    ),
    "From the pickup day on, the fee is not refunded. The deposit is only held at pickup, so there is none to give back before then.",
  ];
}

/** The terms of one booking in words, with its dates and, when given, the amounts. */
export function termsSentences(terms: CancellationTerms, feeCents?: Cents): string[] {
  const last = terms.feeRefund.at(-1);
  return [
    ...terms.feeRefund.map((t) => `If you cancel before ${when(t.before)}, you get back ${shareOf(t.percent, feeCents)}.`),
    last ? `From ${when(last.before)}, the pickup day, and once you have the item, the rental fee is not refunded.` : "The rental fee is not refunded.",
  ];
}

/** The same in one sentence, for the mandate's terms. */
export function termsSummary(terms: CancellationTerms, feeCents?: Cents): string {
  const parts = terms.feeRefund.map((t, i) => (i === 0 ? `If you cancel before ${when(t.before)}, ${shareOf(t.percent, feeCents)} is refunded` : `before ${when(t.before)}, ${shareOf(t.percent, feeCents)}`));
  return `${[...parts, "from then on, nothing"].join("; ")}.`;
}
