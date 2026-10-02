import { ApiError } from "@paypal/paypal-server-sdk";

const BRAND = Symbol.for("handback.PayPalError");

/**
 * One error shape for every PayPal failure, whether it came from the Server
 * SDK or from our own REST calls. `issue` is the machine-readable reason
 * (details[0].issue) that callers branch on; `debugId` is what PayPal support
 * asks for and is logged with every failure.
 */
export class PayPalError extends Error {
  readonly [BRAND] = true;

  constructor(
    readonly status: number,
    readonly errorName: string,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }

  /**
   * Use this, not instanceof. Next.js bundles route handlers and pages with
   * their own copy of this module, while the one gateway is shared through
   * globalThis, so a page can receive a PayPalError built by another copy.
   */
  static is(err: unknown): err is PayPalError {
    return typeof err === "object" && err !== null && (err as { [BRAND]?: unknown })[BRAND] === true;
  }

  /** True when retrying the same request later could succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

type ErrorBody = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string }[];
  error?: string;
  error_description?: string;
};

export function paypalErrorFromBody(status: number, body: unknown, headerDebugId?: string | null): PayPalError {
  const b = (typeof body === "object" && body !== null ? body : {}) as ErrorBody;
  const detail = b.details?.[0];
  const name = b.name ?? b.error ?? `HTTP_${status}`;
  const message = detail?.description ?? b.message ?? b.error_description ?? `PayPal returned ${status}`;
  return new PayPalError(status, name, detail?.issue, b.debug_id ?? headerDebugId ?? undefined, message);
}

/** Normalises anything thrown by a Server SDK call into a PayPalError. */
export function toPayPalError(err: unknown): PayPalError {
  if (PayPalError.is(err)) return err;
  if (err instanceof ApiError) {
    let body: unknown = err.result;
    if (body === undefined && typeof err.body === "string") {
      try {
        body = JSON.parse(err.body);
      } catch {
        body = undefined;
      }
    }
    const header = err.headers?.["paypal-debug-id"];
    return paypalErrorFromBody(err.statusCode, body, header);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new PayPalError(0, "NETWORK_ERROR", undefined, undefined, message);
}
