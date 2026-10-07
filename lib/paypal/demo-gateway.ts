import { PayPalError } from "./errors";
import {
  assertSettleable,
  AUTHORIZATION_VALID_DAYS,
  REAUTHORIZE_FROM_DAY,
  type Authorization,
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

const DAY_MS = 86_400_000;

type DemoOrder = {
  id: string;
  intent: "CAPTURE" | "AUTHORIZE";
  totalCents: number;
  savePayPal: boolean;
  authorizationId?: string;
  captureId?: string;
  vaultId?: string;
};
type DemoAuth = Authorization & { capturedCents: number; reauthorized: boolean };
type DemoCapture = { id: string; amountCents: number; refundedCents: number };

export type DemoState = {
  seq: number;
  orders: Record<string, DemoOrder>;
  auths: Record<string, DemoAuth>;
  captures: Record<string, DemoCapture>;
  vaults: Record<string, string>;
  replies: Record<string, unknown>;
};

/** Where the stand-in keeps its state; the app persists it, tests keep it in memory. */
export interface DemoStore {
  load(): Promise<DemoState | null>;
  save(state: DemoState): Promise<void>;
}

const memoryStore = (): DemoStore => ({ load: async () => null, save: async () => {} });

/**
 * A stand-in for PayPal that enforces the rules we verified in the sandbox
 * (docs/paypal-sandbox-notes.md), so DEMO_MODE behaves like the real thing:
 * no over-capture, one reauthorization between day 4 and day 29, no void
 * after a final capture, and a repeated PayPal-Request-Id returns the first
 * result instead of acting twice.
 */
export class DemoDepositGateway implements DepositGateway {
  readonly mode = "demo" as const;
  private state: DemoState = { seq: 0, orders: {}, auths: {}, captures: {}, vaults: {}, replies: {} };
  private loaded: Promise<void> | undefined;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly store: DemoStore = memoryStore(),
  ) {}

  private async ready() {
    this.loaded ??= this.store.load().then((s) => {
      if (s) this.state = s;
    });
    await this.loaded;
  }

  private id(prefix: string): string {
    this.state.seq += 1;
    return `${prefix}-${this.state.seq.toString().padStart(6, "0")}`;
  }

  private async once<T>(requestId: string, action: () => T): Promise<T> {
    await this.ready();
    if (requestId in this.state.replies) return this.state.replies[requestId] as T;
    const result = action();
    this.state.replies[requestId] = result;
    await this.store.save(this.state);
    return result;
  }

  private auth(authorizationId: string): DemoAuth {
    const auth = this.state.auths[authorizationId];
    if (!auth) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Authorization not found.");
    return auth;
  }

  private view(auth: DemoAuth): Authorization {
    return {
      authorizationId: auth.authorizationId,
      status: auth.status,
      amountCents: auth.amountCents,
      createdAt: auth.createdAt,
      expiresAt: auth.expiresAt,
      vaultId: auth.vaultId,
      payerEmail: auth.payerEmail,
    };
  }

  private newAuth(totalCents: number, vaultId?: string): DemoAuth {
    const created = this.now();
    const auth: DemoAuth = {
      authorizationId: this.id("DEMO-AUTH"),
      status: "CREATED",
      amountCents: totalCents,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + AUTHORIZATION_VALID_DAYS * DAY_MS).toISOString(),
      vaultId,
      payerEmail: "renter@example.com",
      capturedCents: 0,
      reauthorized: false,
    };
    this.state.auths[auth.authorizationId] = auth;
    return auth;
  }

  private newCapture(amountCents: number): DemoCapture {
    const capture: DemoCapture = { id: this.id("DEMO-CAPTURE"), amountCents, refundedCents: 0 };
    this.state.captures[capture.id] = capture;
    return capture;
  }

  private vault(vaultId: string) {
    if (!this.state.vaults[vaultId]) throw fail(422, "UNPROCESSABLE_ENTITY", "INVALID_PAYMENT_TOKEN", "Payment token not found.");
  }

  /**
   * Like PayPal, answers with a payer-action link. It opens the app's own
   * demo approval page (app/demo/paypal), which sends the buyer back to the
   * return URL the way PayPal does.
   */
  async createBookingOrder(req: BookingOrderRequest, requestId: string): Promise<Hold> {
    return this.once(requestId, () => {
      const order: DemoOrder = { id: this.id("DEMO-ORDER"), intent: "CAPTURE", totalCents: req.feeCents, savePayPal: true };
      this.state.orders[order.id] = order;
      const approveUrl = new URL(`/demo/paypal?token=${order.id}`, req.returnUrl).toString();
      return { orderId: order.id, status: "PAYER_ACTION_REQUIRED", approveUrl };
    });
  }

  /** In demo mode the buyer's approval is implied. */
  async captureBookingOrder(orderId: string, requestId: string): Promise<BookingCapture> {
    return this.once(requestId, () => {
      const order = this.state.orders[orderId];
      if (!order) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found.");
      if (order.captureId) throw fail(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", "Order already captured.");
      const capture = this.newCapture(order.totalCents);
      order.captureId = capture.id;
      const vaultId = this.id("DEMO-VAULT");
      this.state.vaults[vaultId] = "renter@example.com";
      order.vaultId = vaultId;
      return { captureId: capture.id, status: "COMPLETED", capturedCents: order.totalCents, vaultId, payerEmail: "renter@example.com" };
    });
  }

  async getBookingOrder(orderId: string): Promise<BookingCapture | null> {
    await this.ready();
    const order = this.state.orders[orderId];
    if (!order) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found.");
    if (!order.captureId) return null;
    return { captureId: order.captureId, status: "COMPLETED", capturedCents: order.totalCents, vaultId: order.vaultId, payerEmail: "renter@example.com" };
  }

  async holdWithSavedWallet(req: SavedWalletRequest, requestId: string): Promise<Authorization> {
    return this.once(requestId, () => {
      this.vault(req.vaultId);
      return this.view(this.newAuth(req.amountCents, req.vaultId));
    });
  }

  async chargeSavedWallet(req: SavedWalletRequest, requestId: string): Promise<{ captureId: string; status: string }> {
    return this.once(requestId, () => {
      this.vault(req.vaultId);
      return { captureId: this.newCapture(req.amountCents).id, status: "COMPLETED" };
    });
  }

  async createHold(req: HoldRequest, requestId: string): Promise<Hold> {
    return this.once(requestId, () => {
      const order: DemoOrder = {
        id: this.id("DEMO-ORDER"),
        intent: "AUTHORIZE",
        totalCents: req.feeCents + req.depositCents,
        savePayPal: req.savePayPal,
      };
      this.state.orders[order.id] = order;
      return { orderId: order.id, status: "PAYER_ACTION_REQUIRED" };
    });
  }

  async authorizeHold(orderId: string, requestId: string): Promise<Authorization> {
    return this.once(requestId, () => {
      const order = this.state.orders[orderId];
      if (!order) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found.");
      if (order.authorizationId) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED", "Order already authorized.");
      }
      let vaultId: string | undefined;
      if (order.savePayPal) {
        vaultId = this.id("DEMO-VAULT");
        this.state.vaults[vaultId] = "renter@example.com";
      }
      const auth = this.newAuth(order.totalCents, vaultId);
      order.authorizationId = auth.authorizationId;
      return this.view(auth);
    });
  }

  async getAuthorization(authorizationId: string): Promise<Authorization> {
    await this.ready();
    return this.view(this.auth(authorizationId));
  }

  async settle(req: SettleRequest, requestId: string): Promise<Settlement> {
    assertSettleable(req);
    return this.once(requestId, () => {
      const auth = this.auth(req.authorizationId);
      if (auth.status !== "CREATED") {
        throw fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_COMPLETED", `Authorization is ${auth.status}.`);
      }
      if (req.amountCents > auth.amountCents - auth.capturedCents) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED", "Capture amount exceeds allowable limit.");
      }
      const capture = this.newCapture(req.amountCents);
      auth.capturedCents += req.amountCents;
      auth.status = "CAPTURED";
      return {
        captureId: capture.id,
        status: "COMPLETED",
        capturedCents: req.amountCents,
        releasedCents: auth.amountCents - auth.capturedCents,
      };
    });
  }

  async release(authorizationId: string, requestId: string): Promise<void> {
    await this.once(requestId, () => {
      const auth = this.auth(authorizationId);
      if (auth.status === "CAPTURED") {
        throw fail(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED", "A fully captured authorization cannot be voided.");
      }
      if (auth.status === "VOIDED") {
        throw fail(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", "Authorization was already voided.");
      }
      auth.status = "VOIDED";
      return true;
    });
  }

  async reauthorize(authorizationId: string, amountCents: number, requestId: string): Promise<Authorization> {
    return this.once(requestId, () => {
      const auth = this.auth(authorizationId);
      const ageDays = Math.floor((this.now().getTime() - Date.parse(auth.createdAt)) / DAY_MS);
      if (ageDays < REAUTHORIZE_FROM_DAY - 1) {
        throw fail(
          422,
          "UNPROCESSABLE_ENTITY",
          "REAUTHORIZATION_TOO_SOON",
          "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.",
        );
      }
      if (auth.reauthorized || ageDays >= AUTHORIZATION_VALID_DAYS || auth.status !== "CREATED") {
        throw fail(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_NOT_ALLOWED", "This authorization cannot be reauthorized.");
      }
      if (amountCents > auth.amountCents) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "MAX_AUTHORIZATION_AMOUNT_EXCEEDED", "Reauthorization exceeds the allowed amount.");
      }
      auth.reauthorized = true;
      const fresh = this.newAuth(amountCents, auth.vaultId);
      fresh.reauthorized = true;
      // Measured in the sandbox (docs/paypal-sandbox-notes.md): the new authorization
      // keeps the original's expiry, 29 days after the first hold, and the original
      // still reads CREATED right after it is reauthorized.
      fresh.expiresAt = auth.expiresAt;
      return this.view(fresh);
    });
  }

  /**
   * Not PayPal API: the demo's sample history (lib/insights/seed.ts) moves a
   * hold back in time. The stand-in's own clock has to agree, or it would
   * refuse the hourly renewal as too soon and report an expiry 29 days from
   * the seeding instead of from the moved-back pickup.
   */
  async backdateAuthorization(authorizationId: string, createdAt: Date): Promise<void> {
    await this.ready();
    const auth = this.auth(authorizationId);
    auth.createdAt = createdAt.toISOString();
    auth.expiresAt = new Date(createdAt.getTime() + AUTHORIZATION_VALID_DAYS * DAY_MS).toISOString();
    await this.store.save(this.state);
  }

  /** Not PayPal API: the demo dispute stand-in reports money a dispute returned on a capture, so later refunds see less left. */
  async recordDisputeRefund(captureId: string, cents: number): Promise<void> {
    await this.ready();
    const capture = this.state.captures[captureId];
    if (!capture) return;
    capture.refundedCents = Math.min(capture.amountCents, capture.refundedCents + cents);
    await this.store.save(this.state);
  }

  async refund(req: RefundRequest, requestId: string): Promise<RefundResult> {
    return this.once(requestId, () => {
      const capture = this.state.captures[req.captureId];
      if (!capture) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Capture not found.");
      if (req.amountCents <= 0 || req.amountCents > capture.amountCents - capture.refundedCents) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "Refund amount exceeds the refundable amount.");
      }
      capture.refundedCents += req.amountCents;
      return { refundId: this.id("DEMO-REFUND"), status: "COMPLETED", amountCents: req.amountCents };
    });
  }
}

function fail(status: number, name: string, issue: string, message: string): PayPalError {
  return new PayPalError(status, name, issue, `demo-${issue.toLowerCase()}`, message);
}
