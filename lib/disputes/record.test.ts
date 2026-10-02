// How a new description of a dispute from PayPal replaces or updates the
// stored one, and what a dispute does to the rental's status.
import { describe, expect, it } from "vitest";
import { nextDisputeView, rentalStatusFor, type DisputeLike } from "./record";

const waiting: DisputeLike = {
  dispute_id: "PP-R-HKL-10190228",
  update_time: "2026-10-02T14:00:23.000Z",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "INCORRECT_AMOUNT",
  dispute_amount: { currency_code: "USD", value: "20.00" },
  seller_response_due_date: "2026-10-13T06:59:59.000Z",
  allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } },
  links: [{ rel: "provide_evidence", method: "POST", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-HKL-10190228/provide-evidence" }],
};

// The shape of the sandbox GET after evidence (2026-10-02 14:58): no deadline, no allowed_response_options.
const reviewing: DisputeLike = {
  dispute_id: "PP-R-HKL-10190228",
  update_time: "2026-10-02T14:58:13.711Z",
  status: "UNDER_REVIEW",
  reason: "INCORRECT_AMOUNT",
  dispute_amount: { currency_code: "USD", value: "20.00" },
  links: [{ rel: "self", method: "GET", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-HKL-10190228" }],
};

describe("nextDisputeView", () => {
  it("replaces the stored view with a full read, so a deadline PayPal stopped sending is gone", () => {
    const next = nextDisputeView(waiting, reviewing, "paypal");
    expect(next).toEqual(reviewing);
    expect(next).not.toHaveProperty("seller_response_due_date");
    expect(next).not.toHaveProperty("allowed_response_options");
  });

  it("drops keys set to undefined, as JSON would", () => {
    expect(nextDisputeView(waiting, { ...reviewing, seller_response_due_date: undefined }, "demo")).not.toHaveProperty("seller_response_due_date");
  });

  it("lays a webhook resource over the stored view but keeps a deadline only while PayPal waits on the shop", () => {
    const partial: DisputeLike = { dispute_id: waiting.dispute_id, status: "UNDER_REVIEW", update_time: "2026-10-02T14:04:00.000Z" };
    const next = nextDisputeView(waiting, partial, "webhook");
    expect(next).toMatchObject({ status: "UNDER_REVIEW", reason: "INCORRECT_AMOUNT", dispute_amount: waiting.dispute_amount });
    expect(next).not.toHaveProperty("seller_response_due_date");

    const still = nextDisputeView(waiting, { dispute_id: waiting.dispute_id, status: "WAITING_FOR_SELLER_RESPONSE" }, "webhook");
    expect(still.seller_response_due_date).toBe("2026-10-13T06:59:59.000Z");

    const asked = nextDisputeView(reviewing, { dispute_id: waiting.dispute_id, status: "WAITING_FOR_SELLER_RESPONSE", seller_response_due_date: "2026-10-06T06:59:59.000Z" }, "webhook");
    expect(asked.seller_response_due_date).toBe("2026-10-06T06:59:59.000Z");
  });

  it("takes the first view as it comes", () => {
    expect(nextDisputeView(null, waiting, "webhook")).toEqual(waiting);
  });
});

describe("rentalStatusFor", () => {
  it("shows a settled rental as disputed while a case is open, and settled again once it closes", () => {
    expect(rentalStatusFor("settled", "WAITING_FOR_SELLER_RESPONSE")).toBe("disputed");
    expect(rentalStatusFor("disputed", "RESOLVED")).toBe("settled");
  });

  it("leaves a running rental where it is", () => {
    expect(rentalStatusFor("booked", "OPEN")).toBe("booked");
    expect(rentalStatusFor("out", "RESOLVED")).toBe("out");
  });
});
