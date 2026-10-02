// Plain words for PayPal's dispute enums, for the counter and the customer.

type Tone = "brand" | "held" | "released" | "charged" | "note" | "neutral";

export function disputeStatusLabel(status: string, outcome: string | null): { label: string; tone: Tone } {
  if (status === "RESOLVED") {
    if (outcome === "RESOLVED_SELLER_FAVOUR") return { label: "Decided for the shop", tone: "released" };
    if (outcome === "RESOLVED_BUYER_FAVOUR") return { label: "Decided for the customer", tone: "charged" };
    if (outcome === "CANCELED_BY_BUYER") return { label: "Withdrawn by the customer", tone: "released" };
    return { label: "Closed", tone: "neutral" };
  }
  switch (status) {
    case "WAITING_FOR_SELLER_RESPONSE":
      return { label: "Your answer needed", tone: "charged" };
    case "UNDER_REVIEW":
      return { label: "PayPal is reviewing", tone: "held" };
    case "WAITING_FOR_BUYER_RESPONSE":
      return { label: "Waiting for the customer", tone: "held" };
    default:
      return { label: "Opened", tone: "neutral" };
  }
}

export const STAGE_LABEL: Record<string, string> = {
  INQUIRY: "Inquiry: between the shop and the customer",
  CHARGEBACK: "Claim: PayPal decides",
  PRE_ARBITRATION: "First appeal",
  ARBITRATION: "Second appeal",
};

/** What PayPal asks the seller for, in words a counter understands. */
export const EVIDENCE_LABEL: Record<string, string> = {
  OTHER: "other documents",
  PROOF_OF_REFUND: "proof of a refund",
  PROOF_OF_FULFILLMENT: "proof of shipment",
  PROOF_OF_DELIVERY_SIGNATURE: "a delivery signature",
  PROOF_OF_RECEIPT_COPY: "a copy of the receipt",
  PRICE_DIFFERENCE_REASON: "why the price differs",
  PROOF_OF_DAMAGE: "proof of damage",
  PROOF_OF_INSTORE_RECEIPT: "proof of in-store pickup",
};

export const evidenceLabel = (t: string) => EVIDENCE_LABEL[t] ?? t.toLowerCase().replace(/_/g, " ");

export const OUTCOME_REASON_LABEL: Record<string, string> = {
  INELIGIBLE_BUYER_PROTECTION_POLICY: "not covered by PayPal's Buyer Protection",
  VALID_PROOF_SUPPORTING_CLAIM: "the customer's proof supported the claim",
  NO_SELLER_RESPONSE: "the shop did not answer in time",
  SELLER_ISSUED_REFUND: "the shop refunded",
};
