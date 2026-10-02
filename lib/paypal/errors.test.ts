import { describe, expect, it, vi } from "vitest";

describe("PayPalError.is", () => {
  it("recognises a PayPalError built by another copy of the module, where instanceof fails", async () => {
    // Next.js gives route handlers and pages their own copy of this module,
    // and the gateway that throws these errors is shared through globalThis.
    const first = await import("./errors");
    vi.resetModules();
    const second = await import("./errors");
    expect(second.PayPalError).not.toBe(first.PayPalError);

    const err = new second.PayPalError(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "f73514956e4a5", "Payer has not yet approved the Order.");
    expect(err instanceof first.PayPalError).toBe(false);
    expect(first.PayPalError.is(err)).toBe(true);
    expect(first.toPayPalError(err)).toBe(err);

    expect(first.PayPalError.is(Object.assign(new Error("x"), { name: "PayPalError" }))).toBe(false);
    expect(first.PayPalError.is(null)).toBe(false);
  });
});
