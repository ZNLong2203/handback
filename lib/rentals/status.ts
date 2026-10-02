import type { Rental, RentalStatus } from "./types";

type Tone = "brand" | "held" | "released" | "charged" | "note" | "neutral";

export const STATUS: Record<RentalStatus, { label: string; customerLabel?: string; tone: Tone; customerTone?: Tone; staffNext: string; customer: string }> = {
  draft: { label: "Not paid", tone: "neutral", staffNext: "Waiting for PayPal approval", customer: "Finish paying to confirm your booking." },
  booked: { label: "Booked", tone: "brand", staffNext: "Photograph it and hold the deposit at pickup", customer: "You're booked. The deposit is held at pickup, not now." },
  out: { label: "Out", customerLabel: "Deposit held", tone: "held", staffNext: "Photograph it when it comes back", customer: "Enjoy it. Your deposit is held on PayPal, not charged." },
  inspecting: { label: "Needs review", customerLabel: "Being checked", tone: "charged", staffNext: "Review what the photos show", customer: "The shop is checking the return photos." },
  customer_review: { label: "With customer", customerLabel: "Your review needed", tone: "held", staffNext: "Waiting for the customer's answers", customer: "Please review what the shop found." },
  responded: { label: "Customer answered", customerLabel: "Answers sent", tone: "charged", staffNext: "Read the answers and settle", customer: "Thanks. The shop is reading your answers." },
  settled: { label: "Settled", tone: "released", staffNext: "Done", customer: "All settled." },
  cancelled: { label: "Cancelled", tone: "neutral", staffNext: "Done", customer: "This booking was cancelled." },
  disputed: { label: "Disputed", customerLabel: "Case with PayPal", tone: "charged", customerTone: "neutral", staffNext: "Answer the PayPal dispute", customer: "PayPal is looking at a case about this rental." },
};

/**
 * The renter approved and PayPal accepted the fee capture but left it
 * PENDING: the rental stays unpaid until PayPal's webhook says how it ended.
 */
export const feePending = (r: Pick<Rental, "status" | "feeCaptureId">) => r.status === "draft" && r.feeCaptureId !== null;

/** The steps of a rental, for the progress strip. */
export const STEPS: { key: string; label: string; statuses: RentalStatus[] }[] = [
  { key: "book", label: "Booked", statuses: ["booked"] },
  { key: "pickup", label: "Deposit held", statuses: ["out"] },
  { key: "return", label: "Returned", statuses: ["inspecting"] },
  { key: "review", label: "Customer review", statuses: ["customer_review", "responded"] },
  { key: "settle", label: "Settled", statuses: ["settled", "disputed"] },
];

export function stepIndex(status: RentalStatus): number {
  const i = STEPS.findIndex((s) => s.statuses.includes(status));
  return i < 0 ? 0 : i;
}

const EVENT_LABEL: Record<string, string> = {
  "mandate.issued": "Deposit mandate issued",
  "mandate.refused": "Refused: outside the renter's deposit mandate",
  "booking.started": "Booking started; PayPal order created",
  "booking.paid": "Rental fee paid; PayPal saved for the deposit",
  "booking.pending": "Rental fee approved; PayPal is still processing it",
  "booking.declined": "PayPal did not take the rental fee",
  "photo.added": "Photo recorded",
  "deposit.held": "Deposit held on PayPal",
  "checkout.acknowledged": "Customer confirmed the pickup photos",
  "inspection.completed": "Two AI looks compared the photos",
  "inspection.failed": "Photo comparison failed; nothing was saved",
  "finding.kept": "Counter kept a finding",
  "finding.waived": "Counter waived a finding",
  "review.sent": "Findings sent to the customer",
  "customer.responded": "Customer answered",
  "contest.upheld": "Counter kept a questioned charge",
  "contest.waived": "Counter waived a questioned charge",
  "deposit.settled": "Deposit settled: charge captured, rest released",
  "deposit.released": "Whole deposit released",
  "paypal.error": "PayPal refused a step",
  "webhook.received": "PayPal confirmed by webhook",
  "deposit.reauthorized": "Deposit hold renewed",
  "dispute.opened": "Customer opened a PayPal dispute",
  "dispute.updated": "PayPal updated the dispute",
  "dispute.resolved": "PayPal closed the dispute",
  "dispute.evidence_sent": "Evidence pack sent to PayPal",
  "dispute.offer_made": "Shop offered a refund through PayPal",
  "dispute.claim_accepted": "Shop accepted the claim; PayPal refunds the customer",
  "dispute.sandbox_evidence_requested": "Sandbox: PayPal's test system asked for evidence",
  "dispute.sandbox_decided": "Sandbox: PayPal's test system decided the case",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type;
}
