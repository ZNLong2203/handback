import type { Cents } from "@/lib/money";
import type { PayPalMode } from "./config";

/**
 * The deposit lifecycle Handback needs from a payment provider. One PayPal
 * order with intent AUTHORIZE holds the rental fee plus the deposit; one final
 * capture settles fee + approved damage and releases the rest.
 *
 * Every mutating call takes a requestId, sent as PayPal-Request-Id, so a retry
 * of the same logical action can never move money twice.
 */
export interface DepositGateway {
  readonly mode: PayPalMode;
  createHold(req: HoldRequest, requestId: string): Promise<Hold>;
  authorizeHold(orderId: string, requestId: string): Promise<Authorization>;
  getAuthorization(authorizationId: string): Promise<Authorization>;
  settle(req: SettleRequest, requestId: string): Promise<Settlement>;
  release(authorizationId: string, requestId: string): Promise<void>;
  reauthorize(authorizationId: string, amountCents: Cents, requestId: string): Promise<Authorization>;
  refund(req: RefundRequest, requestId: string): Promise<RefundResult>;
}

export type HoldRequest = {
  bookingId: string;
  itemName: string;
  rentalDays: number;
  feeCents: Cents;
  depositCents: Cents;
  shopName: string;
  returnUrl: string;
  cancelUrl: string;
  /** Ask PayPal to save the wallet so later charges need no buyer present. */
  savePayPal: boolean;
};

export type Hold = {
  orderId: string;
  status: string;
  /** Where to send the buyer when not using the JS SDK popup. */
  approveUrl?: string;
};

export type AuthorizationStatus =
  | "CREATED"
  | "CAPTURED"
  | "PARTIALLY_CAPTURED"
  | "VOIDED"
  | "EXPIRED"
  | "DENIED"
  | "PENDING";

export type Authorization = {
  authorizationId: string;
  status: AuthorizationStatus;
  amountCents: Cents;
  createdAt: string;
  expiresAt?: string;
  /** Present when the buyer agreed to save PayPal for later charges. */
  vaultId?: string;
  payerEmail?: string;
};

export type SettleRequest = {
  authorizationId: string;
  /** Fee plus approved damage. Must not exceed the authorized amount. */
  amountCents: Cents;
  authorizedCents: Cents;
  invoiceId: string;
  noteToPayer: string;
};

export type Settlement = {
  captureId: string;
  status: string;
  capturedCents: Cents;
  releasedCents: Cents;
};

export type RefundRequest = {
  captureId: string;
  amountCents: Cents;
  noteToPayer: string;
};

export type RefundResult = { refundId: string; status: string };

/** Honor period and reauthorization window, as enforced by the sandbox. */
export const HONOR_PERIOD_DAYS = 3;
export const REAUTHORIZE_FROM_DAY = 4;
export const AUTHORIZATION_VALID_DAYS = 29;

/**
 * Deterministic guard in front of every settlement: PayPal rejects
 * over-capture with MAX_CAPTURE_AMOUNT_EXCEEDED, and we never want to find
 * that out by asking it.
 */
export function assertSettleable(req: SettleRequest): void {
  if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) {
    throw new RangeError("settlement must be a positive whole number of cents; release the hold instead");
  }
  if (req.amountCents > req.authorizedCents) {
    throw new RangeError(
      `settlement of ${req.amountCents}¢ exceeds the ${req.authorizedCents}¢ held; collect the difference separately`,
    );
  }
}
