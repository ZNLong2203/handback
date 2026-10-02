import "server-only";
import {
  CheckoutPaymentIntent,
  ItemCategory,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  PaymentInitiator,
  StoreInVaultInstruction,
  StoredPaymentSourceUsageType,
  UsagePattern,
} from "@paypal/paypal-server-sdk";
import type { AuthorizationWithAdditionalData, Order, PaymentAuthorization } from "@paypal/paypal-server-sdk";
import { fromPayPalValue, toPayPalValue } from "@/lib/money";
import { toPayPalError } from "./errors";
import {
  assertSettleable,
  type Authorization,
  type AuthorizationStatus,
  type BookingCapture,
  type BookingOrderRequest,
  type DepositGateway,
  type Hold,
  type HoldRequest,
  type RefundRequest,
  type RefundResult,
  type SavedWalletRequest,
  type SettleRequest,
  type Settlement,
} from "./gateway";
import { paypalClient } from "./sdk";

const PREFER = "return=representation";
const usd = (cents: number) => ({ currencyCode: "USD", value: toPayPalValue(cents) });

async function call<T>(fn: () => Promise<{ result: T }>): Promise<T> {
  try {
    return (await fn()).result;
  } catch (err) {
    throw toPayPalError(err);
  }
}

function toAuthorization(
  auth: AuthorizationWithAdditionalData | PaymentAuthorization | undefined,
  extra: { vaultId?: string; payerEmail?: string } = {},
): Authorization {
  if (!auth?.id || !auth.amount) throw new Error("PayPal returned no authorization");
  return {
    authorizationId: auth.id,
    status: (auth.status ?? "PENDING") as AuthorizationStatus,
    amountCents: fromPayPalValue(auth.amount.value),
    createdAt: auth.createTime ?? new Date().toISOString(),
    expiresAt: auth.expirationTime,
    ...extra,
  };
}

function firstAuthorization(order: Order) {
  return order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
}

export class PayPalDepositGateway implements DepositGateway {
  readonly mode;
  private readonly orders: OrdersController;
  private readonly payments: PaymentsController;

  constructor(mode: "sandbox" | "live") {
    this.mode = mode;
    const client = paypalClient();
    this.orders = new OrdersController(client);
    this.payments = new PaymentsController(client);
  }

  async createBookingOrder(req: BookingOrderRequest, requestId: string): Promise<Hold> {
    const order = await call(() =>
      this.orders.createOrder({
        paypalRequestId: requestId,
        prefer: PREFER,
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: req.rentalId,
              customId: req.rentalId,
              invoiceId: `${req.rentalId}-fee`,
              description: `${req.itemName}, ${req.rentalDays} day rental`,
              softDescriptor: "HANDBACK",
              amount: { ...usd(req.feeCents), breakdown: { itemTotal: usd(req.feeCents) } },
              items: [
                {
                  name: `Rental: ${req.itemName} (${req.rentalDays} days)`,
                  description: `A refundable ${toPayPalValue(req.depositCents)} USD deposit is held at pickup, not now.`,
                  quantity: "1",
                  unitAmount: usd(req.feeCents),
                  category: ItemCategory.DigitalGoods,
                },
              ],
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: req.shopName,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                userAction: PaypalExperienceUserAction.PayNow,
                returnUrl: req.returnUrl,
                cancelUrl: req.cancelUrl,
              },
              attributes: {
                vault: {
                  storeInVault: StoreInVaultInstruction.OnSuccess,
                  usageType: PaypalPaymentTokenUsageType.Merchant,
                  customerType: PaypalPaymentTokenCustomerType.Consumer,
                  description: `${req.shopName} holds a refundable deposit at pickup and charges only approved damage`,
                },
              },
            },
          },
        },
      }),
    );
    if (!order.id) throw new Error("PayPal returned an order without an id");
    const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    return { orderId: order.id, status: order.status ?? "CREATED", approveUrl };
  }

  async captureBookingOrder(orderId: string, requestId: string): Promise<BookingCapture> {
    const order = await call(() => this.orders.captureOrder({ id: orderId, paypalRequestId: requestId, prefer: PREFER }));
    const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
    if (!capture?.id || !capture.amount) throw new Error("PayPal returned no capture for the booking");
    const wallet = order.paymentSource?.paypal;
    return {
      captureId: capture.id,
      status: capture.status ?? "PENDING",
      capturedCents: fromPayPalValue(capture.amount.value),
      vaultId: wallet?.attributes?.vault?.id,
      payerEmail: wallet?.emailAddress,
    };
  }

  /** Merchant-initiated: the buyer consented at booking and is not present now. */
  private savedWallet(vaultId: string) {
    return {
      paypal: {
        vaultId,
        storedCredential: {
          paymentInitiator: PaymentInitiator.Merchant,
          usage: StoredPaymentSourceUsageType.Subsequent,
          usagePattern: UsagePattern.UnscheduledPostpaid,
        },
      },
    };
  }

  async holdWithSavedWallet(req: SavedWalletRequest, requestId: string): Promise<Authorization> {
    const order = await call(() =>
      this.orders.createOrder({
        paypalRequestId: requestId,
        prefer: PREFER,
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              referenceId: req.rentalId,
              customId: req.rentalId,
              invoiceId: `${req.rentalId}-deposit`,
              description: req.description,
              softDescriptor: "HANDBACK DEPOSIT",
              amount: usd(req.amountCents),
            },
          ],
          paymentSource: this.savedWallet(req.vaultId),
        },
      }),
    );
    return toAuthorization(firstAuthorization(order), { vaultId: req.vaultId });
  }

  async chargeSavedWallet(req: SavedWalletRequest, requestId: string): Promise<{ captureId: string; status: string }> {
    const order = await call(() =>
      this.orders.createOrder({
        paypalRequestId: requestId,
        prefer: PREFER,
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: req.rentalId,
              customId: req.rentalId,
              invoiceId: `${req.rentalId}-extra`,
              description: req.description,
              amount: usd(req.amountCents),
            },
          ],
          paymentSource: this.savedWallet(req.vaultId),
        },
      }),
    );
    const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
    if (!capture?.id) throw new Error("PayPal returned no capture for the saved-wallet charge");
    return { captureId: capture.id, status: capture.status ?? "PENDING" };
  }

  async createHold(req: HoldRequest, requestId: string): Promise<Hold> {
    const total = req.feeCents + req.depositCents;
    const order = await call(() =>
      this.orders.createOrder({
        paypalRequestId: requestId,
        prefer: PREFER,
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              referenceId: req.bookingId,
              customId: req.bookingId,
              description: `${req.itemName}, ${req.rentalDays} day rental with refundable deposit`,
              softDescriptor: "HANDBACK",
              amount: { ...usd(total), breakdown: { itemTotal: usd(total) } },
              items: [
                {
                  name: `Rental: ${req.itemName} (${req.rentalDays} days)`,
                  quantity: "1",
                  unitAmount: usd(req.feeCents),
                  category: ItemCategory.DigitalGoods,
                },
                {
                  name: "Refundable damage deposit",
                  description: "Held, not charged. Released when the item comes back as it left.",
                  quantity: "1",
                  unitAmount: usd(req.depositCents),
                  category: ItemCategory.DigitalGoods,
                },
              ],
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: req.shopName,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                userAction: PaypalExperienceUserAction.Continue,
                returnUrl: req.returnUrl,
                cancelUrl: req.cancelUrl,
              },
              attributes: req.savePayPal
                ? {
                    vault: {
                      storeInVault: StoreInVaultInstruction.OnSuccess,
                      usageType: PaypalPaymentTokenUsageType.Merchant,
                      customerType: PaypalPaymentTokenCustomerType.Consumer,
                      description: `${req.shopName} may charge late fees or damage above the deposit`,
                    },
                  }
                : undefined,
            },
          },
        },
      }),
    );
    if (!order.id) throw new Error("PayPal returned an order without an id");
    const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    return { orderId: order.id, status: order.status ?? "CREATED", approveUrl };
  }

  async authorizeHold(orderId: string, requestId: string): Promise<Authorization> {
    const order = await call(() => this.orders.authorizeOrder({ id: orderId, paypalRequestId: requestId, prefer: PREFER }));
    const wallet = order.paymentSource?.paypal;
    return toAuthorization(firstAuthorization(order as Order), {
      vaultId: wallet?.attributes?.vault?.id,
      payerEmail: wallet?.emailAddress,
    });
  }

  async getAuthorization(authorizationId: string): Promise<Authorization> {
    return toAuthorization(await call(() => this.payments.getAuthorizedPayment({ authorizationId })));
  }

  async settle(req: SettleRequest, requestId: string): Promise<Settlement> {
    assertSettleable(req);
    const capture = await call(() =>
      this.payments.captureAuthorizedPayment({
        authorizationId: req.authorizationId,
        paypalRequestId: requestId,
        prefer: PREFER,
        body: {
          amount: usd(req.amountCents),
          finalCapture: true,
          invoiceId: req.invoiceId,
          noteToPayer: req.noteToPayer.slice(0, 255),
        },
      }),
    );
    if (!capture.id || !capture.amount) throw new Error("PayPal returned no capture");
    const captured = fromPayPalValue(capture.amount.value);
    return {
      captureId: capture.id,
      status: capture.status ?? "PENDING",
      capturedCents: captured,
      releasedCents: req.authorizedCents - captured,
    };
  }

  async release(authorizationId: string, requestId: string): Promise<void> {
    await call(() => this.payments.voidPayment({ authorizationId, paypalRequestId: requestId, prefer: PREFER }));
  }

  async reauthorize(authorizationId: string, amountCents: number, requestId: string): Promise<Authorization> {
    return toAuthorization(
      await call(() =>
        this.payments.reauthorizePayment({
          authorizationId,
          paypalRequestId: requestId,
          prefer: PREFER,
          body: { amount: usd(amountCents) },
        }),
      ),
    );
  }

  async refund(req: RefundRequest, requestId: string): Promise<RefundResult> {
    const refund = await call(() =>
      this.payments.refundCapturedPayment({
        captureId: req.captureId,
        paypalRequestId: requestId,
        prefer: PREFER,
        body: { amount: usd(req.amountCents), noteToPayer: req.noteToPayer.slice(0, 255) },
      }),
    );
    if (!refund.id) throw new Error("PayPal returned no refund");
    return { refundId: refund.id, status: refund.status ?? "PENDING" };
  }
}
