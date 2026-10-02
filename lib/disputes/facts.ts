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
  money: { feeCents: Cents; heldCents: Cents | null; capturedCents: Cents | null; releasedCents: Cents | null; extraCents: Cents | null; settledAt: string | null };
  pickup: { sha256: string; takenAt: string; acknowledgedAt: string | null } | null;
  returned: { sha256: string; takenAt: string } | null;
  inspection: { source: Assessment["source"]; model: string; comparedAt: string; sentAt: string | null; answeredAt: string | null } | null;
  findings: EvidenceFinding[];
  audit: { entries: number; headHash: string | null; intact: boolean; brokenAtSeq: number | null };
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
  };
}

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
  add("rental", `Rental ${r.id}: ${r.item}, rented by ${r.customer} from ${f.shop}, picked up ${r.startDate} and due back ${r.endDate} (${r.days} day${r.days === 1 ? "" : "s"}).`);
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
