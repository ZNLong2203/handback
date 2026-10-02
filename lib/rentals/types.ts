import type { AssessedFinding } from "@/lib/inspection/policy";
import type { Cents } from "@/lib/money";

export const RENTAL_STATUSES = [
  "draft",
  "booked",
  "out",
  "inspecting",
  "customer_review",
  "responded",
  "settled",
  "cancelled",
  "disputed",
] as const;
export type RentalStatus = (typeof RENTAL_STATUSES)[number];

export type Rental = {
  id: string;
  token: string;
  itemId: string;
  customerName: string;
  customerEmail: string;
  startDate: string;
  endDate: string;
  days: number;
  feeCents: Cents;
  depositCents: Cents;
  status: RentalStatus;
  bookingOrderId: string | null;
  feeCaptureId: string | null;
  vaultId: string | null;
  payerEmail: string | null;
  authorizationId: string | null;
  parentAuthorizationId: string | null;
  authorizedCents: Cents | null;
  authorizedAt: string | null;
  authorizationExpiresAt: string | null;
  settlementCaptureId: string | null;
  capturedCents: Cents | null;
  releasedCents: Cents | null;
  extraCaptureId: string | null;
  extraCents: Cents | null;
  settledAt: string | null;
  disputeId: string | null;
  /** PayPal's payer-action link for approving the booking by redirect. */
  approveUrl: string | null;
  /** Canonical JSON of the deposit mandate and its SHA-256 (see mandate.ts). Null on rentals booked before mandates. */
  mandateJson: string | null;
  mandateSha256: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Phase = "checkout" | "checkin";

export type Inspection = {
  id: string;
  rentalId: string;
  phase: Phase;
  photoSha: string;
  quality: { brightness: number; sharpness: number; problems: string[] };
  sample: string | null;
  takenAt: string;
  acknowledgedAt: string | null;
};

/**
 * A finding after people have weighed in. `staff` is the counter's call before
 * the customer sees it; `customer` is the renter's answer on their own phone;
 * `resolution` is the counter's final word on a contested finding.
 */
export type ReviewedFinding = AssessedFinding & {
  staff: "keep" | "waive";
  customer: "accept" | "contest" | null;
  customerNote: string | null;
  resolution: "charge" | "waive" | null;
};

export type AssessmentStatus = "staff_review" | "customer_review" | "responded" | "final";

export type Assessment = {
  id: string;
  rentalId: string;
  checkoutSha: string;
  checkinSha: string;
  model: string;
  /** live = Gemini ran now; replay = recorded Gemini output for a bundled sample; unavailable = no AI. */
  source: "live" | "replay" | "unavailable";
  usable: boolean;
  issue: string | null;
  summary: string;
  findings: ReviewedFinding[];
  proposedCents: Cents;
  status: AssessmentStatus;
  createdAt: string;
  sentAt: string | null;
  respondedAt: string | null;
};

export type AuditEvent = {
  seq: number;
  rentalId: string;
  at: string;
  actor: "customer" | "assistant" | "staff" | "system" | "paypal" | "ai";
  type: string;
  data: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
};

/** Thrown for problems a person can act on; the message is shown as-is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
