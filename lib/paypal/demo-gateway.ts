import { PayPalError } from "./errors";
import {
  assertSettleable,
  AUTHORIZATION_VALID_DAYS,
  REAUTHORIZE_FROM_DAY,
  type Authorization,
  type DepositGateway,
  type Hold,
  type HoldRequest,
  type RefundRequest,
  type RefundResult,
  type SettleRequest,
  type Settlement,
} from "./gateway";

const DAY_MS = 86_400_000;

type DemoOrder = { id: string; totalCents: number; savePayPal: boolean; authorizationId?: string };
type DemoAuth = Authorization & { capturedCents: number; reauthorized: boolean };
type DemoCapture = { id: string; amountCents: number; refundedCents: number };

/**
 * An in-memory stand-in for PayPal that enforces the rules we verified in the
 * sandbox (docs/paypal-sandbox-notes.md), so DEMO_MODE behaves like the real
 * thing: no over-capture, one reauthorization between day 4 and day 29, no
 * void after a final capture, and the same PayPal-Request-Id returns the
 * first result instead of acting twice.
 */
export class DemoDepositGateway implements DepositGateway {
  readonly mode = "demo" as const;
  private orders = new Map<string, DemoOrder>();
  private auths = new Map<string, DemoAuth>();
  private captures = new Map<string, DemoCapture>();
  private replies = new Map<string, unknown>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString().padStart(6, "0")}`;
  }

  private once<T>(requestId: string, action: () => T): T {
    if (this.replies.has(requestId)) return this.replies.get(requestId) as T;
    const result = action();
    this.replies.set(requestId, result);
    return result;
  }

  private auth(authorizationId: string): DemoAuth {
    const auth = this.auths.get(authorizationId);
    if (!auth) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Authorization not found.");
    return auth;
  }

  private view(auth: DemoAuth): Authorization {
    const { capturedCents: _c, reauthorized: _r, ...rest } = auth;
    return { ...rest };
  }

  async createHold(req: HoldRequest, requestId: string): Promise<Hold> {
    return this.once(requestId, () => {
      const order: DemoOrder = {
        id: this.id("DEMO-ORDER"),
        totalCents: req.feeCents + req.depositCents,
        savePayPal: req.savePayPal,
      };
      this.orders.set(order.id, order);
      return { orderId: order.id, status: "PAYER_ACTION_REQUIRED" };
    });
  }

  /** In demo mode the buyer's approval is implied. */
  async authorizeHold(orderId: string, requestId: string): Promise<Authorization> {
    return this.once(requestId, () => {
      const order = this.orders.get(orderId);
      if (!order) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found.");
      if (order.authorizationId) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED", "Order already authorized.");
      }
      const created = this.now();
      const auth: DemoAuth = {
        authorizationId: this.id("DEMO-AUTH"),
        status: "CREATED",
        amountCents: order.totalCents,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + AUTHORIZATION_VALID_DAYS * DAY_MS).toISOString(),
        vaultId: order.savePayPal ? this.id("DEMO-VAULT") : undefined,
        payerEmail: "renter@example.com",
        capturedCents: 0,
        reauthorized: false,
      };
      order.authorizationId = auth.authorizationId;
      this.auths.set(auth.authorizationId, auth);
      return this.view(auth);
    });
  }

  async getAuthorization(authorizationId: string): Promise<Authorization> {
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
      const capture: DemoCapture = { id: this.id("DEMO-CAPTURE"), amountCents: req.amountCents, refundedCents: 0 };
      this.captures.set(capture.id, capture);
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
    this.once(requestId, () => {
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
      const created = this.now();
      const fresh: DemoAuth = {
        ...auth,
        authorizationId: this.id("DEMO-AUTH"),
        amountCents,
        createdAt: created.toISOString(),
        capturedCents: 0,
        reauthorized: true,
      };
      auth.status = "VOIDED";
      this.auths.set(fresh.authorizationId, fresh);
      return this.view(fresh);
    });
  }

  async refund(req: RefundRequest, requestId: string): Promise<RefundResult> {
    return this.once(requestId, () => {
      const capture = this.captures.get(req.captureId);
      if (!capture) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Capture not found.");
      if (req.amountCents <= 0 || req.amountCents > capture.amountCents - capture.refundedCents) {
        throw fail(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "Refund amount exceeds the refundable amount.");
      }
      capture.refundedCents += req.amountCents;
      return { refundId: this.id("DEMO-REFUND"), status: "COMPLETED" };
    });
  }
}

function fail(status: number, name: string, issue: string, message: string): PayPalError {
  return new PayPalError(status, name, issue, `demo-${issue.toLowerCase()}`, message);
}
