import { describe, expect, it } from "vitest";
import { DemoDepositGateway } from "./demo-gateway";
import { PayPalError } from "./errors";
import type { HoldRequest } from "./gateway";

const DAY = 86_400_000;

const hold: HoldRequest = {
  bookingId: "bk_1",
  itemName: "24-70mm f/2.8 lens",
  rentalDays: 3,
  feeCents: 8000,
  depositCents: 30000,
  shopName: "Kestrel Camera Rentals",
  returnUrl: "http://localhost:3000/return",
  cancelUrl: "http://localhost:3000/cancel",
  savePayPal: true,
};

function setup(start = Date.parse("2026-10-02T10:00:00Z")) {
  let now = start;
  const gateway = new DemoDepositGateway(() => new Date(now));
  return { gateway, advanceDays: (d: number) => (now += d * DAY) };
}

async function authorized(gateway: DemoDepositGateway) {
  const { orderId } = await gateway.createHold(hold, "create-1");
  return gateway.authorizeHold(orderId, "authorize-1");
}

async function issueOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(PayPalError);
    return (err as PayPalError).issue;
  }
}

describe("DemoDepositGateway", () => {
  it("holds fee plus deposit and saves the wallet when asked", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    expect(auth.amountCents).toBe(38000);
    expect(auth.status).toBe("CREATED");
    expect(auth.vaultId).toBeDefined();
  });

  it("settles fee plus damage in one final capture and releases the rest", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    const s = await gateway.settle(
      { authorizationId: auth.authorizationId, amountCents: 12500, authorizedCents: 38000, invoiceId: "inv-1", noteToPayer: "fee + scratch" },
      "settle-1",
    );
    expect(s).toMatchObject({ capturedCents: 12500, releasedCents: 25500, status: "COMPLETED" });
    expect((await gateway.getAuthorization(auth.authorizationId)).status).toBe("CAPTURED");
  });

  it("returns the first result when the same request id is retried", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    const req = { authorizationId: auth.authorizationId, amountCents: 8000, authorizedCents: 38000, invoiceId: "inv-2", noteToPayer: "fee" };
    const first = await gateway.settle(req, "settle-same");
    const second = await gateway.settle(req, "settle-same");
    expect(second.captureId).toBe(first.captureId);
  });

  it("refuses to capture more than was held, before calling anything", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    await expect(
      gateway.settle({ authorizationId: auth.authorizationId, amountCents: 40000, authorizedCents: 38000, invoiceId: "x", noteToPayer: "" }, "over"),
    ).rejects.toThrow(RangeError);
  });

  it("cannot void after a final capture", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    await gateway.settle({ authorizationId: auth.authorizationId, amountCents: 8000, authorizedCents: 38000, invoiceId: "i", noteToPayer: "" }, "s");
    expect(await issueOf(gateway.release(auth.authorizationId, "void-late"))).toBe("PREVIOUSLY_CAPTURED");
  });

  it("allows one reauthorization, only from day 4 to day 29", async () => {
    const { gateway, advanceDays } = setup();
    const auth = await authorized(gateway);
    expect(await issueOf(gateway.reauthorize(auth.authorizationId, 38000, "re-0"))).toBe("REAUTHORIZATION_TOO_SOON");
    advanceDays(3);
    const fresh = await gateway.reauthorize(auth.authorizationId, 38000, "re-1");
    expect(fresh.authorizationId).not.toBe(auth.authorizationId);
    expect(await issueOf(gateway.reauthorize(auth.authorizationId, 38000, "re-2"))).toBe("REAUTHORIZATION_NOT_ALLOWED");
  });

  it("counts the 72 hours and keeps the original expiry, as the sandbox did", async () => {
    const { gateway, advanceDays } = setup();
    const auth = await authorized(gateway);
    advanceDays(3 - 5 / 1440);
    expect(await issueOf(gateway.reauthorize(auth.authorizationId, 38000, "re-early"))).toBe("REAUTHORIZATION_TOO_SOON");
    advanceDays(10 / 1440);
    const fresh = await gateway.reauthorize(auth.authorizationId, 38000, "re-on-time");
    expect(fresh.expiresAt).toBe(auth.expiresAt);
    expect((await gateway.getAuthorization(auth.authorizationId)).status).toBe("CREATED");
  });

  it("refunds no more than was captured", async () => {
    const { gateway } = setup();
    const auth = await authorized(gateway);
    const s = await gateway.settle({ authorizationId: auth.authorizationId, amountCents: 15000, authorizedCents: 38000, invoiceId: "i", noteToPayer: "" }, "s");
    await gateway.refund({ captureId: s.captureId, amountCents: 4000, noteToPayer: "goodwill" }, "r1");
    expect(await issueOf(gateway.refund({ captureId: s.captureId, amountCents: 12000, noteToPayer: "" }, "r2"))).toBe("REFUND_AMOUNT_EXCEEDED");
  });
});

describe("DemoDepositGateway booking flow", () => {
  const booking = {
    rentalId: "R-TEST01",
    itemName: "Mirrorless camera kit",
    rentalDays: 3,
    feeCents: 8700,
    depositCents: 30000,
    shopName: "Kestrel Camera Rentals",
    returnUrl: "http://localhost:3000/r/x",
    cancelUrl: "http://localhost:3000/rent/camera-kit",
  };

  it("captures the fee at booking and returns a saved-wallet token", async () => {
    const { gateway } = setup();
    const { orderId } = await gateway.createBookingOrder(booking, "book-1");
    const paid = await gateway.captureBookingOrder(orderId, "book-capture-1");
    expect(paid).toMatchObject({ status: "COMPLETED", capturedCents: 8700 });
    expect(paid.vaultId).toBeDefined();
  });

  it("holds the deposit on the saved wallet at pickup and settles part of it", async () => {
    const { gateway } = setup();
    const { orderId } = await gateway.createBookingOrder(booking, "book-2");
    const { vaultId } = await gateway.captureBookingOrder(orderId, "book-capture-2");
    const hold = await gateway.holdWithSavedWallet(
      { vaultId: vaultId!, rentalId: "R-TEST01", amountCents: 30000, description: "Refundable deposit" },
      "hold-1",
    );
    expect(hold).toMatchObject({ status: "CREATED", amountCents: 30000 });
    const s = await gateway.settle(
      { authorizationId: hold.authorizationId, amountCents: 3500, authorizedCents: 30000, invoiceId: "R-TEST01-damage", noteToPayer: "Lens hood" },
      "settle-b1",
    );
    expect(s.releasedCents).toBe(26500);
  });

  it("refuses a hold or charge on an unknown wallet token", async () => {
    const { gateway } = setup();
    expect(
      await issueOf(gateway.holdWithSavedWallet({ vaultId: "nope", rentalId: "R", amountCents: 100, description: "" }, "h")),
    ).toBe("INVALID_PAYMENT_TOKEN");
  });

  it("keeps state through its store, like a restart would", async () => {
    let saved: unknown = null;
    const store = { load: async () => saved as never, save: async (s: unknown) => void (saved = structuredClone(s)) };
    const first = new DemoDepositGateway(() => new Date(), store);
    const { orderId } = await first.createBookingOrder(booking, "book-3");
    const { vaultId } = await first.captureBookingOrder(orderId, "book-capture-3");
    const second = new DemoDepositGateway(() => new Date(), store);
    const hold = await second.holdWithSavedWallet({ vaultId: vaultId!, rentalId: "R", amountCents: 100, description: "" }, "hold-3");
    expect(hold.status).toBe("CREATED");
  });
});
