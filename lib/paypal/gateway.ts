import type { Cents } from "@/lib/money";
import type { PayPalMode } from "./config";

/**
 * The rental money lifecycle Handback needs from a payment provider:
 *
 *   booking  the buyer approves once: the rental fee is captured and PayPal
 *            saves the wallet for later merchant-initiated charges;
 *   pickup   the deposit is held (AUTHORIZE) on the saved wallet, so its
 *            29-day clock starts when the item leaves the shop;
 *   return   one final capture takes approved damage and PayPal releases the
 *            rest, or the hold is voided when nothing is owed.
 *
 * Every mutating call takes a requestId, sent as PayPal-Request-Id, so a retry
 * of the same logical action can never move money twice.
 */
export interface DepositGateway {
  readonly mode: PayPalMode;
  /** Booking: an order that captures the rental fee and asks PayPal to save the wallet. */
  createBookingOrder(req: BookingOrderRequest, requestId: string): Promise<Hold>;
  /** After the buyer approves: capture the fee and read back the saved-wallet token. */
  captureBookingOrder(orderId: string, requestId: string): Promise<BookingCapture>;
  /** Pickup: hold the deposit on the saved wallet, buyer not present. */
  holdWithSavedWallet(req: SavedWalletRequest, requestId: string): Promise<Authorization>;
  /** Damage above the deposit: charge the saved wallet directly. */
  chargeSavedWallet(req: SavedWalletRequest, requestId: string): Promise<{ captureId: string; status: string }>;
  /** Fallback when no wallet was saved: an AUTHORIZE order the buyer approves. */
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

export type BookingOrderRequest = {
  rentalId: string;
  itemName: string;
  rentalDays: number;
  feeCents: Cents;
  depositCents: Cents;
  shopName: string;
  returnUrl: string;
  cancelUrl: string;
};

export type BookingCapture = {
  captureId: string;
  status: string;
  capturedCents: Cents;
  /** Saved-wallet token; absent if the buyer's account could not be vaulted. */
  vaultId?: string;
  payerEmail?: string;
};

export type SavedWalletRequest = {
  vaultId: string;
  rentalId: string;
  amountCents: Cents;
  description: string;
  /** PayPal invoice id for a saved-wallet charge; defaults to `<rentalId>-extra`. */
  invoiceId?: string;
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
  /** Shown to the payer in their PayPal activity and PayPal's email; PayPal allows 255 characters. */
  noteToPayer: string;
  /** PayPal allows 127 characters. */
  invoiceId?: string;
};

/** Payments v2 `refund`: status is COMPLETED, PENDING, FAILED or CANCELLED. */
export type RefundResult = { refundId: string; status: string; amountCents: Cents };

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
