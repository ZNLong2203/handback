import { formatUsd, type Cents } from "@/lib/money";
import type { DisputeActions } from "@/lib/paypal/dispute-model";

/**
 * PayPal's US dispute fees, as published. The fee is charged to the seller
 * after the claim is decided; the exemptions below are quoted from the
 * User Agreement's "Dispute fees" section.
 */
export const DISPUTE_FEES = {
  standardCents: 1500,
  highVolumeCents: 3000,
  feesSource: {
    title: "PayPal Merchant Fees (US), Dispute Fees, last updated Oct 1, 2026",
    url: "https://www.paypal.com/us/business/paypal-business-fees",
  },
  rulesSource: {
    title: "PayPal User Agreement (US), Dispute fees, last updated Sep 14, 2026",
    url: "https://www.paypal.com/us/legalhub/paypal/useragreement-full",
  },
} as const;

export type FeeOutlook = {
  /** The fee when it applies: Standard, or High Volume for shops with a 1.5%+ dispute ratio and 100+ sales. */
  feeCents: Cents;
  ifAccepted: Cents;
  ifLost: Cents;
  ifWon: Cents;
  why: string;
};

/**
 * Which dispute fee the shop would pay in each outcome. Standard fee
 * exemptions: inquiries not escalated to a claim, cases settled with the
 * buyer before escalation, unauthorized-transaction claims, transactions
 * under twice the Standard fee, and cases decided in the seller's favor.
 * High Volume fees keep only the first three.
 */
export function disputeFee(i: { stage: string | null; reason: string; transactionCents: Cents; highVolume?: boolean }): FeeOutlook {
  const fee = i.highVolume ? DISPUTE_FEES.highVolumeCents : DISPUTE_FEES.standardCents;
  const inquiry = i.stage === "INQUIRY";
  if (i.reason === "UNAUTHORISED") return { feeCents: 0, ifAccepted: 0, ifLost: 0, ifWon: 0, why: "No dispute fee: PayPal does not charge one for unauthorized-transaction claims." };
  if (!i.highVolume && i.transactionCents < 2 * DISPUTE_FEES.standardCents) {
    return { feeCents: 0, ifAccepted: 0, ifLost: 0, ifWon: 0, why: `No dispute fee: the transaction is under ${formatUsd(2 * DISPUTE_FEES.standardCents)}, twice the Standard fee.` };
  }
  return {
    feeCents: fee,
    ifAccepted: inquiry ? 0 : fee,
    ifLost: fee,
    ifWon: i.highVolume && !inquiry ? fee : 0,
    why: inquiry
      ? `Settling now, before anyone escalates it to a claim, costs no fee. If it becomes a claim and PayPal decides for the customer, the ${formatUsd(fee)} fee applies.`
      : `This is already a claim: accepting it or losing it costs the ${formatUsd(fee)} fee${i.highVolume ? ", and a High Volume fee applies even if the shop wins" : "; winning it costs nothing"}.`,
  };
}

export type RecordStrength = {
  pickupPhoto: boolean;
  pickupConfirmed: boolean;
  returnPhoto: boolean;
  chainIntact: boolean;
  /** Which of the rental's PayPal captures the customer disputed. */
  disputedCapture: "fee" | "settlement" | "extra" | "unknown";
  /** Damage charges the customer accepted on their own phone. */
  acceptedCents: Cents;
  /** Charges the customer questioned that the counter kept anyway. */
  upheldCents: Cents;
};

export type RecommendInput = {
  status: string;
  stage: string | null;
  reason: string;
  disputedCents: Cents;
  transactionCents: Cents;
  actions: DisputeActions;
  record: RecordStrength;
  highVolume?: boolean;
};

export type OptionCost = {
  action: "fight" | "offer" | "accept";
  label: string;
  /** PayPal offers this on the dispute right now. */
  available: boolean;
  /** What the shop pays back, and the fee, in the outcome named. */
  outcomes: { when: string; refundCents: Cents; feeCents: Cents }[];
};

export type Recommendation = {
  action: "fight" | "offer" | "accept" | "wait" | "done";
  headline: string;
  reasons: string[];
  offerCents: Cents | null;
  options: OptionCost[];
  fee: FeeOutlook;
};

/**
 * Fight, offer or accept, from what the record can prove and what PayPal
 * allows right now. It shows costs per outcome; it does not guess the odds
 * of winning, which nobody outside PayPal knows.
 */
export function recommend(i: RecommendInput): Recommendation {
  const fee = disputeFee({ stage: i.stage, reason: i.reason, transactionCents: i.transactionCents, highVolume: i.highVolume });
  const r = i.record;
  const canOffer = Boolean(i.actions.makeOffer?.includes("REFUND"));
  const canAccept = i.actions.acceptClaim !== null;
  const offerCents = r.upheldCents > 0 && r.upheldCents < i.disputedCents ? r.upheldCents : null;
  const options: OptionCost[] = [
    {
      action: "fight",
      label: "Send the evidence pack",
      available: i.actions.provideEvidence,
      outcomes: [
        { when: "PayPal decides for the shop", refundCents: 0, feeCents: fee.ifWon },
        { when: "PayPal decides for the customer", refundCents: i.disputedCents, feeCents: fee.ifLost },
      ],
    },
    ...(offerCents
      ? [{ action: "offer" as const, label: `Offer to refund ${formatUsd(offerCents)}`, available: canOffer, outcomes: [{ when: "The customer takes it", refundCents: offerCents, feeCents: 0 }] }]
      : []),
    { action: "accept", label: "Accept the claim", available: canAccept, outcomes: [{ when: "PayPal refunds the customer now", refundCents: i.disputedCents, feeCents: fee.ifAccepted }] },
  ];
  const base = { offerCents, options, fee };

  if (i.status === "RESOLVED") return { ...base, action: "done", headline: "PayPal has closed this dispute.", reasons: [] };
  if (!i.actions.provideEvidence && !canAccept && !canOffer) {
    return {
      ...base,
      action: "wait",
      headline: "Nothing to answer right now.",
      reasons: [i.status === "UNDER_REVIEW" ? "PayPal is reviewing the case." : `The dispute is ${i.status.toLowerCase().replace(/_/g, " ")}.`, "PayPal will ask for evidence or decide; this page updates when it does."],
    };
  }

  const gaps = [
    !r.pickupPhoto && "there is no pickup photo",
    !r.returnPhoto && "there is no return photo",
    r.pickupPhoto && !r.pickupConfirmed && "the customer never confirmed the pickup photo",
    !r.chainIntact && "the audit log does not verify",
  ].filter(Boolean) as string[];
  if (gaps.length > 0) {
    return {
      ...base,
      action: canAccept ? "accept" : "fight",
      headline: canAccept ? "Accept: the record cannot back this charge." : "Send what there is; the record has gaps.",
      reasons: [`The evidence is weak: ${gaps.join(", ")}.`],
    };
  }

  const record = ["The customer confirmed the pickup photo on their own phone.", "Both photos are on record with their SHA-256, and the audit log verifies."];
  if (r.disputedCapture === "fee") {
    return { ...base, action: "fight", headline: "Fight: the rental happened as booked.", reasons: ["The customer approved the rental fee in PayPal at booking.", ...record] };
  }
  if (r.upheldCents === 0) {
    return {
      ...base,
      action: "fight",
      headline: "Fight: the customer accepted these charges before they were taken.",
      reasons: [`The customer accepted ${formatUsd(r.acceptedCents)} of charges on their own phone before PayPal captured anything.`, ...record],
    };
  }
  if (offerCents && canOffer) {
    return {
      ...base,
      action: "offer",
      headline: `Offer ${formatUsd(offerCents)}: the part the customer questioned.`,
      reasons: [
        `The customer accepted ${formatUsd(r.acceptedCents)} on their phone but questioned ${formatUsd(r.upheldCents)}, which the counter charged anyway.`,
        "Refunding the questioned part settles it without a claim, so no dispute fee.",
        ...record,
      ],
    };
  }
  return {
    ...base,
    action: "fight",
    headline: "Fight, and say plainly which charge the customer questioned.",
    reasons: [`The customer questioned ${formatUsd(r.upheldCents)} that the counter kept; PayPal does not allow an offer at this stage.`, ...record],
  };
}
