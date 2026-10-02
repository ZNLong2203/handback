import { describe, expect, it } from "vitest";
import type { DisputeActions } from "@/lib/paypal/dispute-model";
import { disputeFee, recommend, type RecommendInput } from "./recommend";

const none: DisputeActions = {
  provideEvidence: false,
  acceptClaim: null,
  makeOffer: null,
  escalate: false,
  sendMessage: false,
  provideSupportingInfo: false,
  appeal: false,
  requireEvidence: false,
  adjudicate: false,
};
/** What the sandbox offered on a billing claim once it asked the seller for evidence. */
const claimActions: DisputeActions = { ...none, provideEvidence: true, acceptClaim: ["REFUND"] };
const inquiryActions: DisputeActions = { ...none, provideEvidence: true, acceptClaim: ["REFUND", "PARTIAL_REFUND"], makeOffer: ["REFUND"], escalate: true, sendMessage: true };

const strong = { pickupPhoto: true, pickupConfirmed: true, returnPhoto: true, chainIntact: true, disputedCapture: "settlement" as const, acceptedCents: 3500, upheldCents: 0 };
const input = (over: Partial<RecommendInput> = {}): RecommendInput => ({
  status: "WAITING_FOR_SELLER_RESPONSE",
  stage: "CHARGEBACK",
  reason: "INCORRECT_AMOUNT",
  disputedCents: 2000,
  transactionCents: 3500,
  actions: claimActions,
  record: strong,
  ...over,
});

describe("disputeFee", () => {
  it("charges the Standard fee on a claim unless the shop wins", () => {
    expect(disputeFee({ stage: "CHARGEBACK", reason: "INCORRECT_AMOUNT", transactionCents: 3500 })).toMatchObject({ feeCents: 1500, ifAccepted: 1500, ifLost: 1500, ifWon: 0 });
  });
  it("charges nothing for settling an inquiry before it becomes a claim", () => {
    expect(disputeFee({ stage: "INQUIRY", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", transactionCents: 3500 })).toMatchObject({ ifAccepted: 0, ifLost: 1500 });
  });
  it("exempts unauthorized claims and transactions under twice the Standard fee", () => {
    expect(disputeFee({ stage: "CHARGEBACK", reason: "UNAUTHORISED", transactionCents: 50000 }).ifLost).toBe(0);
    expect(disputeFee({ stage: "CHARGEBACK", reason: "INCORRECT_AMOUNT", transactionCents: 2999 }).ifLost).toBe(0);
    expect(disputeFee({ stage: "CHARGEBACK", reason: "INCORRECT_AMOUNT", transactionCents: 3000 }).ifLost).toBe(1500);
  });
  it("keeps the High Volume fee even when the shop wins a claim", () => {
    expect(disputeFee({ stage: "CHARGEBACK", reason: "INCORRECT_AMOUNT", transactionCents: 2000, highVolume: true })).toMatchObject({ feeCents: 3000, ifWon: 3000 });
  });
});

describe("recommend", () => {
  it("fights when the customer accepted every charge on their phone", () => {
    const r = recommend(input());
    expect(r.action).toBe("fight");
    expect(r.reasons[0]).toContain("accepted $35.00");
    expect(r.options.find((o) => o.action === "fight")?.outcomes).toEqual([
      { when: "PayPal decides for the shop", refundCents: 0, feeCents: 0 },
      { when: "PayPal decides for the customer", refundCents: 2000, feeCents: 1500 },
    ]);
    expect(r.options.find((o) => o.action === "accept")).toMatchObject({ available: true, outcomes: [{ refundCents: 2000, feeCents: 1500 }] });
  });

  it("offers the questioned part back in an inquiry, where PayPal allows offers", () => {
    const r = recommend(input({ stage: "INQUIRY", actions: inquiryActions, disputedCents: 9500, transactionCents: 9500, record: { ...strong, acceptedCents: 3500, upheldCents: 6000 } }));
    expect(r).toMatchObject({ action: "offer", offerCents: 6000 });
    expect(r.options.find((o) => o.action === "offer")).toMatchObject({ available: true, outcomes: [{ refundCents: 6000, feeCents: 0 }] });
  });

  it("does not offer when the stage has no make_offer link", () => {
    const r = recommend(input({ disputedCents: 9500, transactionCents: 9500, record: { ...strong, upheldCents: 6000 } }));
    expect(r.action).toBe("fight");
    expect(r.options.find((o) => o.action === "offer")?.available).toBe(false);
  });

  it("recommends accepting when the record has gaps", () => {
    const r = recommend(input({ record: { ...strong, pickupConfirmed: false, chainIntact: false } }));
    expect(r.action).toBe("accept");
    expect(r.reasons[0]).toContain("never confirmed the pickup photo");
    expect(r.reasons[0]).toContain("audit log does not verify");
  });

  it("waits while PayPal reviews, and is done once resolved", () => {
    expect(recommend(input({ status: "UNDER_REVIEW", actions: { ...none, provideSupportingInfo: true } })).action).toBe("wait");
    expect(recommend(input({ status: "RESOLVED", actions: none })).action).toBe("done");
  });
});
