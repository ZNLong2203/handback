import type { Box, FindingKind } from "@/lib/inspection/schema";
import { formatUsd, type Cents } from "@/lib/money";
import { firstBrokenLink } from "@/lib/rentals/audit";
import { isCharged } from "@/lib/rentals/settlement";
import type { Assessment, AuditEvent, Inspection, Rental } from "@/lib/rentals/types";

/**
 * Everything an evidence pack states, taken only from what Handback recorded
 * while the rental happened. Plain JSON, so the same record always gives the
 * same facts, and the facts hash identifies a pack's content.
 */
export type EvidenceFinding = {
  n: number;
  kind: FindingKind;
  item: string;
  description: string;
  boxBefore: Box | null;
  boxAfter: Box | null;
  price: { label: string; cents: Cents } | null;
  /** Proposed as a charge (not just a note). */
  proposed: boolean;
  staff: "keep" | "waive";
  customer: "accept" | "contest" | null;
  customerNote: string | null;
  resolution: "charge" | "waive" | null;
  charged: boolean;
};

export type EvidenceFacts = {
  version: 1;
  /** Time of the newest audit entry the pack covers. */
  asOf: string;
  shop: string;
  rental: { id: string; item: string; customer: string; startDate: string; endDate: string; days: number };
  dispute: { id: string; reason: string; amountCents: Cents | null; transactionId: string | null; openedAt: string | null } | null;
  paypal: {
    bookingOrderId: string | null;
    feeCaptureId: string | null;
    authorizationId: string | null;
    previousAuthorizationId: string | null;
    settlementCaptureId: string | null;
    extraCaptureId: string | null;
  };
  money: {
    feeCents: Cents;
    heldCents: Cents | null;
    capturedCents: Cents | null;
    releasedCents: Cents | null;
    extraCents: Cents | null;
    settledAt: string | null;
    /** Refunds on PayPal after payment, oldest first; left out when there are none, so older packs hash the same. */
    refunds?: FactRefund[];
  };
  pickup: { sha256: string; takenAt: string; acknowledgedAt: string | null } | null;
  returned: { sha256: string; takenAt: string } | null;
  inspection: { source: Assessment["source"]; model: string; comparedAt: string; sentAt: string | null; answeredAt: string | null } | null;
  findings: EvidenceFinding[];
  audit: { entries: number; headHash: string | null; intact: boolean; brokenAtSeq: number | null };
  /** Set when the booking was cancelled before pickup; left out otherwise, so older packs hash the same. */
  cancellation?: FactCancellation;
};

export type FactRefund = { refundId: string | null; captureId: string; cents: Cents; at: string };

/** A booking cancelled before pickup, as the rental's record and its deposit mandate state it. */
export type FactCancellation = {
  at: string;
  by: "renter" | "staff";
  /** The reason the counter gave the customer. */
  reason: string | null;
  /** The cancellation terms that applied: the share of the fee refunded before each moment. */
  terms: { before: string; percent: number }[];
  /** "mandate": fixed in the deposit mandate the customer approved in PayPal at booking; "policy": the shop's policy, for bookings whose mandate carries no terms. */
  termsFrom: "mandate" | "policy";
  /** The mandate's SHA-256, as the audit log recorded it at booking, when the terms come from it. */
  mandateSha256: string | null;
  /** The policy's share at the moment of cancelling. */
  policyPercent: number;
  /** The part of the fee the cancellation decided to refund. */
  refundCents: Cents;
};

export type EvidenceSource = {
  shop: { name: string; city: string };
  rental: Rental;
  itemName: string;
  checkout: Inspection | null;
  checkin: Inspection | null;
  assessment: Assessment | null;
  events: AuditEvent[];
  dispute: EvidenceFacts["dispute"];
  /** Refunds PayPal made or reported on the rental's captures (lib/rentals/refunds.ts, refunded ones only). */
  refunds?: FactRefund[];
  cancellation?: FactCancellation;
};

export function buildEvidenceFacts(s: EvidenceSource): EvidenceFacts {
  const r = s.rental;
  const head = s.events.at(-1) ?? null;
  const broken = firstBrokenLink(s.events);
  const a = s.assessment;
  return {
    version: 1,
    asOf: head?.at ?? r.updatedAt,
    shop: `${s.shop.name}, ${s.shop.city}`,
    rental: { id: r.id, item: s.itemName, customer: r.customerName, startDate: r.startDate, endDate: r.endDate, days: r.days },
    dispute: s.dispute,
    paypal: {
      bookingOrderId: r.bookingOrderId,
      feeCaptureId: r.feeCaptureId,
      authorizationId: r.authorizationId,
      previousAuthorizationId: r.parentAuthorizationId,
      settlementCaptureId: r.settlementCaptureId,
      extraCaptureId: r.extraCaptureId,
    },
    money: {
      feeCents: r.feeCents,
      heldCents: r.authorizedCents,
      capturedCents: r.capturedCents,
      releasedCents: r.releasedCents,
      extraCents: r.extraCents,
      settledAt: r.settledAt,
      refunds: s.refunds?.length
        ? [...s.refunds].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.refundId ?? "") < (b.refundId ?? "") ? -1 : 1))
        : undefined,
    },
    pickup: s.checkout ? { sha256: s.checkout.photoSha, takenAt: s.checkout.takenAt, acknowledgedAt: s.checkout.acknowledgedAt } : null,
    returned: s.checkin ? { sha256: s.checkin.photoSha, takenAt: s.checkin.takenAt } : null,
    inspection: a ? { source: a.source, model: a.model, comparedAt: a.createdAt, sentAt: a.sentAt, answeredAt: a.respondedAt } : null,
    findings: (a?.findings ?? []).map((f, i) => ({
      n: i + 1,
      kind: f.kind,
      item: f.item,
      description: f.description,
      boxBefore: f.boxBefore,
      boxAfter: f.boxAfter,
      price: f.price ? { label: f.price.label, cents: f.price.cents } : null,
      proposed: f.decision !== "note" && Boolean(f.price),
      staff: f.staff,
      customer: f.customer,
      customerNote: f.customerNote,
      resolution: f.resolution,
      charged: isCharged(f),
    })),
    audit: { entries: s.events.length, headHash: head?.hash ?? null, intact: broken === null, brokenAtSeq: broken },
    ...(s.cancellation ? { cancellation: s.cancellation } : {}),
  };
}

/** What was refunded of the rental fee, by the refunds in the facts. */
export function feeRefunded(f: EvidenceFacts): Cents {
  return (f.money.refunds ?? []).filter((x) => x.captureId === f.paypal.feeCaptureId).reduce((s, x) => s + x.cents, 0);
}

/** The cancellation terms as one clause: "100% of the fee if cancelled before 2026-10-09 00:00 UTC; 50% ...". */
export function termsClause(c: FactCancellation): string {
  return `${c.terms.map((t) => `${t.percent}% of the fee back if cancelled before ${utc(t.before)}`).join("; ")}; nothing from then on`;
}

/** Who cancelled, in the pack's words. */
export const canceller = (f: EvidenceFacts) => (f.cancellation?.by === "staff" ? f.shop.split(",")[0] : f.rental.customer);

// ─── Wording shared by the PDF, the narrative and PayPal's notes ────

/** "2026-10-02 14:05 UTC": fixed format, no locale or time zone, so output is reproducible. */
export function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export const KIND_LABEL: Record<FindingKind, string> = {
  missing: "Missing",
  new_damage: "New damage",
  dirt: "Needs cleaning",
  pre_existing: "Already there at pickup",
  wear: "Normal wear",
};

export const REASON_LABEL: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not as described",
  UNAUTHORISED: "unauthorized transaction",
  CREDIT_NOT_PROCESSED: "credit not processed",
  DUPLICATE_TRANSACTION: "charged twice",
  INCORRECT_AMOUNT: "charged the wrong amount",
  PAYMENT_BY_OTHER_MEANS: "paid another way",
  CANCELED_RECURRING_BILLING: "canceled recurring billing",
  PROBLEM_WITH_REMITTANCE: "problem with remittance",
  OTHER: "other",
};

export const reasonLabel = (reason: string) => REASON_LABEL[reason] ?? reason.toLowerCase().replace(/_/g, " ");

/** What the customer said about a finding, in the pack's words. */
export function customerAnswer(f: EvidenceFinding, answeredAt: string | null): string {
  if (!f.proposed || f.staff === "waive") return "Not asked (not charged)";
  if (f.customer === "accept") return answeredAt ? `Accepted on their phone, ${utc(answeredAt)}` : "Accepted on their phone";
  if (f.customer === "contest") return `Questioned: "${f.customerNote ?? ""}"`;
  return "No answer recorded";
}

/** The counter's part in a finding. */
export function counterDecision(f: EvidenceFinding): string {
  if (!f.proposed) return "Note only, never charged";
  if (f.staff === "waive") return "Waived before the customer saw it";
  if (f.customer === "contest") return f.resolution === "charge" ? "Kept after reading the answer" : f.resolution === "waive" ? "Waived after reading the answer" : "Not decided";
  return f.charged ? "Charged as accepted" : "Not charged";
}

export type Fact = { id: string; text: string };

/**
 * The facts as numbered sentences. The narrative may only use these, and
 * every number, amount, date and id it writes must appear in a fact it cites.
 */
export function factList(f: EvidenceFacts): Fact[] {
  const out: Fact[] = [];
  const add = (id: string, text: string) => out.push({ id, text });
  const r = f.rental;
  const days = `${r.days} day${r.days === 1 ? "" : "s"}`;
  const pickedUp = Boolean(f.pickup || f.paypal.authorizationId || f.money.settledAt);
  add(
    "rental",
    f.cancellation
      ? `Rental ${r.id}: ${r.item}, booked by ${r.customer} from ${f.shop} for ${r.startDate} to ${r.endDate} (${days}), and cancelled before pickup, so the item never left the shop.`
      : pickedUp
        ? `Rental ${r.id}: ${r.item}, rented by ${r.customer} from ${f.shop}, picked up ${r.startDate} and due back ${r.endDate} (${days}).`
        : `Rental ${r.id}: ${r.item}, booked by ${r.customer} from ${f.shop} for ${r.startDate} to ${r.endDate} (${days}); not picked up when this pack was made.`,
  );
  add("fee", `Rental fee ${formatUsd(f.money.feeCents)} paid with PayPal at booking${f.paypal.feeCaptureId ? ` (capture ${f.paypal.feeCaptureId})` : ""}.`);
  if (f.money.heldCents !== null && f.paypal.authorizationId) {
    const renewed = f.paypal.previousAuthorizationId ? `, renewed from authorization ${f.paypal.previousAuthorizationId}` : "";
    add("deposit", `Deposit ${formatUsd(f.money.heldCents)} held on PayPal at pickup (authorization ${f.paypal.authorizationId}${renewed}); a hold, not a charge.`);
  }
  if (f.pickup) {
    add("pickup.photo", `Pickup photo taken ${utc(f.pickup.takenAt)}, SHA-256 ${f.pickup.sha256}.`);
    if (f.pickup.acknowledgedAt) add("pickup.confirmed", `The customer confirmed the pickup photo on their own phone at ${utc(f.pickup.acknowledgedAt)}.`);
  }
  if (f.returned) add("return.photo", `Return photo taken ${utc(f.returned.takenAt)}, SHA-256 ${f.returned.sha256}.`);
  if (f.inspection) {
    const i = f.inspection;
    const how =
      i.source === "live"
        ? `Two independent ${i.model} looks compared the pickup and return photos at ${utc(i.comparedAt)}; only a change both looks reported could be proposed, priced from the shop's list.`
        : i.source === "replay"
          ? `Recorded ${i.model} replies for these bundled sample photos were used to compare them at ${utc(i.comparedAt)} (demo data).`
          : `The photos were compared by the counter staff at ${utc(i.comparedAt)}; AI comparison was off.`;
    add("inspection", how);
    if (i.sentAt) add("review.sent", `The shop sent the proposed charges to the customer's phone at ${utc(i.sentAt)}, before anything was charged.`);
  }
  for (const x of f.findings) {
    const price = x.price ? `price list: ${x.price.label}, ${formatUsd(x.price.cents)}` : "no price-list entry";
    add(
      `finding.${x.n}`,
      `Finding ${x.n}: ${KIND_LABEL[x.kind].toLowerCase()}, ${x.item}. ${x.description} (${price}). Customer: ${customerAnswer(x, f.inspection?.answeredAt ?? null)}. Counter: ${counterDecision(x)}. ${x.charged ? "Charged." : "Not charged."}`,
    );
  }
  const m = f.money;
  if (m.settledAt) {
    const extra = m.extraCents ? `, plus ${formatUsd(m.extraCents)} above the deposit charged to the saved PayPal wallet${f.paypal.extraCaptureId ? ` (capture ${f.paypal.extraCaptureId})` : ""}` : "";
    const captured = m.capturedCents
      ? `${formatUsd(m.capturedCents)} captured from the deposit${f.paypal.settlementCaptureId ? ` (capture ${f.paypal.settlementCaptureId})` : ""} and ${formatUsd(m.releasedCents ?? 0)} released`
      : `the whole ${formatUsd(m.releasedCents ?? 0)} deposit released`;
    add("settlement", `Settled ${utc(m.settledAt)}: ${captured}${extra}.`);
  }
  if (m.refunds?.length) {
    const which = (captureId: string) =>
      captureId === f.paypal.feeCaptureId ? "the rental fee" : captureId === f.paypal.extraCaptureId ? "the charge above the deposit" : "the settlement capture";
    const total = m.refunds.reduce((s, x) => s + x.cents, 0);
    const list = m.refunds.map((x) => `${formatUsd(x.cents)} of ${which(x.captureId)} (capture ${x.captureId}${x.refundId ? `, refund ${x.refundId}` : ""}, ${utc(x.at)})`);
    add("refunds", `Refunded to the customer through PayPal after payment, ${formatUsd(total)} in all: ${list.join("; ")}.`);
  }
  if (f.cancellation) {
    const c = f.cancellation;
    const terms =
      c.termsFrom === "mandate"
        ? `The cancellation terms were fixed in the deposit mandate the customer approved in PayPal at booking${c.mandateSha256 ? ` (SHA-256 ${c.mandateSha256})` : ""}: ${termsClause(c)}.`
        : `This booking's deposit mandate carries no cancellation terms, so the shop's cancellation policy applied to its pickup day: ${termsClause(c)}.`;
    const decided =
      c.by === "renter"
        ? `Cancelling then gave back ${c.policyPercent}% of the fee, ${formatUsd(c.refundCents)}.`
        : `The shop chose to refund ${formatUsd(c.refundCents)} of the fee${c.reason ? `, with this reason to the customer: "${c.reason}"` : ""}.`;
    add(
      "cancellation",
      `${c.by === "staff" ? "The shop" : r.customer} cancelled the booking at ${utc(c.at)}, before pickup; no deposit was held. ${terms} ${decided} After the refunds in this pack, the shop kept ${formatUsd(Math.max(0, m.feeCents - feeRefunded(f)))} of the ${formatUsd(m.feeCents)} fee.`,
    );
  }
  if (f.dispute) {
    const d = f.dispute;
    add(
      "dispute",
      `PayPal dispute ${d.id} (${reasonLabel(d.reason)})${d.amountCents !== null ? ` for ${formatUsd(d.amountCents)}` : ""}${d.transactionId ? ` on transaction ${d.transactionId}` : ""}${d.openedAt ? `, opened ${utc(d.openedAt)}` : ""}.`,
    );
  }
  add(
    "audit",
    `Handback's audit log for this rental has ${f.audit.entries} entries, each hashing the one before; recomputed for this pack it is ${f.audit.intact ? "intact" : `broken at entry ${f.audit.brokenAtSeq}`}${f.audit.headHash ? `; head hash ${f.audit.headHash}` : ""}.`,
  );
  return out;
}
