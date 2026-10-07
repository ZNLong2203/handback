import { catalogItem } from "@/lib/catalog";
import type { Cents } from "@/lib/money";
import { shopMoney, type Dispute } from "@/lib/paypal/dispute-model";
import { AUTHORIZATION_VALID_DAYS, HONOR_PERIOD_DAYS } from "@/lib/paypal/gateway";
import { renewalDueAt } from "@/lib/rentals/hold-clock";
import { isCharged } from "@/lib/rentals/settlement";
import { STATUS } from "@/lib/rentals/status";
import type { Rental, RentalStatus, ReviewedFinding } from "@/lib/rentals/types";

/**
 * The owner's dashboard data, built from what the database recorded. Pure:
 * the loader (load.ts) reads the rows, this turns them into the tables AG
 * Studio shows, and the tests check that the money adds up.
 *
 * Money stays in integer cents. Each table also carries the same amounts in
 * dollars (cents / 100) for display, because AG Studio formats currency from
 * numbers; sums and identities are checked on the cents.
 *
 * Personal data: the renter appears by first name only. No email, no payer
 * address, no customer link token leaves this module.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type RefundRecord = {
  id: string;
  rentalId: string;
  seq: number | null;
  captureId: string;
  amountCents: Cents;
  state: "requested" | "done" | "refused";
  refundId: string | null;
  paypalStatus: string | null;
  source: "counter" | "webhook";
  createdAt: string;
};

export type DisputeRecord = {
  id: string;
  rentalId: string;
  transactionId: string | null;
  reason: string;
  status: string;
  outcome: string | null;
  amountCents: number | null;
  refundedCents: number | null;
  openedAt: string | null;
  fundMovements: Dispute["fund_movements"];
};

export type AssessmentRecord = {
  rentalId: string;
  status: string;
  findings: ReviewedFinding[];
  createdAt: string;
};

export type PhotoRecord = { rentalId: string; phase: "checkout" | "checkin"; takenAt: string };

export type InsightsInput = {
  now: Date;
  rentals: Rental[];
  refunds: RefundRecord[];
  disputes: DisputeRecord[];
  /** The latest assessment of each rental. */
  assessments: AssessmentRecord[];
  photos: PhotoRecord[];
  /** Unit id to its label ("Camera kit A"). */
  units: Record<string, string>;
};

// ─── Rows ────────────────────────────────────────────────────

export type RentalRow = {
  rental_id: string;
  item: string;
  item_id: string;
  unit: string | null;
  renter: string;
  status: string;
  status_code: RentalStatus;
  start_date: string;
  end_date: string;
  days: number;
  booked_at: string;
  booked_month: string;
  settled_at: string | null;
  settled_month: string | null;
  fee_cents: Cents;
  fee_usd: number;
  deposit_cents: Cents;
  held_cents: Cents;
  held_usd: number;
  captured_cents: Cents;
  extra_cents: Cents;
  released_cents: Cents;
  released_usd: number;
  /** Refunded of what the settlement took (the capture from the hold and the charge above it). */
  refunded_after_cents: Cents;
  /** Given back through a PayPal dispute on the settlement's captures. */
  dispute_returned_cents: Cents;
  /** What the shop keeps of the deposit and the charge above it, after refunds and disputes. */
  kept_cents: Cents;
  kept_usd: number;
  /** Every completed refund on the rental, the booking fee included. */
  refunded_cents: Cents;
  refunded_usd: number;
  cancellation_refund_cents: Cents;
  /** 1 when the deposit was held at pickup, else null (not picked up). */
  picked_up: 1 | null;
  /** 1 when picked up with a pickup photo on record, 0 when picked up without one, null when not picked up. */
  pickup_photographed: 1 | 0 | null;
  open_disputes: number;
};

export type LedgerKind =
  | "fee_capture"
  | "deposit_hold"
  | "hold_renewal"
  | "settlement_capture"
  | "extra_charge"
  | "release"
  | "void"
  | "refund"
  | "cancellation_refund"
  | "dispute_hold"
  | "dispute_hold_released"
  | "dispute_payout"
  | "dispute_fee";

export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  fee_capture: "Rental fee captured",
  deposit_hold: "Deposit hold placed",
  hold_renewal: "Hold renewed (reauthorized)",
  settlement_capture: "Kept from the deposit (final capture)",
  extra_charge: "Charged above the deposit",
  release: "Rest of the hold released",
  void: "Hold voided, nothing kept",
  refund: "Refund after settling",
  cancellation_refund: "Cancellation refund of the fee",
  dispute_hold: "Dispute: PayPal held the shop's money",
  dispute_hold_released: "Dispute: PayPal released the held money",
  dispute_payout: "Dispute: paid back to the renter",
  dispute_fee: "Dispute: PayPal's dispute fee",
};

export type LedgerRow = {
  movement_id: string;
  rental_id: string;
  at: string;
  month: string;
  kind: string;
  kind_code: LedgerKind;
  /** The PayPal id of this movement: a capture, authorization, refund or dispute id. */
  paypal_id: string;
  /** The PayPal id it acts on: the hold a capture or release came from, the capture a refund returns. */
  related_paypal_id: string | null;
  amount_cents: Cents;
  amount_usd: number;
  /** Signed effect on the shop's PayPal balance: + money taken, - money given back or paid out, 0 for holds and releases. */
  shop_net_cents: number;
  shop_net_usd: number;
  status: string;
};

export type FindingRow = {
  finding_id: string;
  rental_id: string;
  item: string;
  found: string;
  kind: string;
  confidence: string;
  price_entry: string | null;
  price_id: string | null;
  ai_decision: string;
  proposed_cents: Cents;
  proposed_usd: number;
  staff_decision: string;
  renter_answer: string;
  final_outcome: string;
  charged_cents: Cents;
  charged_usd: number;
};

export type HoldRow = {
  rental_id: string;
  item: string;
  renter: string;
  authorization_id: string;
  original_authorization_id: string;
  amount_cents: Cents;
  amount_usd: number;
  held_at: string;
  honor_ends_at: string;
  renewal_due_at: string;
  renewed_at: string | null;
  expires_at: string;
  due_back: string;
  hours_held: number;
  days_left: number;
  state: string;
  needs_attention: boolean;
  attention: string | null;
};

export type TimingRow = {
  rental_id: string;
  booked_at: string;
  pickup_at: string | null;
  return_photo_at: string | null;
  settled_at: string | null;
  hours_booking_to_pickup: number | null;
  minutes_return_to_settled: number | null;
};

export type FlowRow = {
  rental_id: string;
  from: string;
  to: string;
  amount_cents: Cents;
  amount_usd: number;
};

export const FLOW = {
  held: "Deposits held",
  above: "Charged above the deposit",
  released: "Released to renters",
  kept: "Captured for repairs",
  stillHeld: "Still held",
  refunded: "Refunded later",
  disputed: "Returned in a dispute",
  openDispute: "In an open dispute",
  keptForGood: "Kept by the shop",
} as const;

export type Summary = {
  generated_at: string;
  held_now_cents: Cents;
  kept_this_month_cents: Cents;
  released_cents: Cents;
  refunded_cents: Cents;
  open_disputes: number;
  pickups: number;
  pickups_photographed: number;
  /** null with no pickups yet. */
  pickups_photographed_share: number | null;
  /** The bike shop's own estimate of photographed pickups before Handback. */
  before_share_low: number;
  before_share_high: number;
  settled_with_return_photo: number;
  /** null with no settled rentals that had a return photo. */
  median_minutes_return_to_settled: number | null;
  holds_needing_attention: number;
};

export type InsightsData = {
  rentals: RentalRow[];
  ledger: LedgerRow[];
  findings: FindingRow[];
  holds: HoldRow[];
  timings: TimingRow[];
  flows: FlowRow[];
  summary: Summary;
};

// ─── Helpers ─────────────────────────────────────────────────

export const usd = (cents: number) => Math.round(cents) / 100;
const month = (iso: string) => iso.slice(0, 7);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const ms = (iso: string) => Date.parse(iso);

/** Money PayPal took and kept moving: refunds PayPal accepted and has not reported failed. */
export const refundCounts = (r: RefundRecord) => r.state === "done" && r.paypalStatus !== "FAILED" && r.paypalStatus !== "CANCELLED";

/**
 * Whether the booking fee was really taken: a capture id on a rental past
 * draft. A booking PayPal declined (a pending capture denied by webhook) is
 * cancelled without cancelled_at, and its fee never moved.
 */
export function feeTaken(r: Rental): boolean {
  if (!r.feeCaptureId || r.status === "draft") return false;
  return !(r.status === "cancelled" && r.cancelledAt === null);
}

const ACTIVE: RentalStatus[] = ["out", "inspecting", "customer_review", "responded"];
const SETTLED: RentalStatus[] = ["settled", "disputed"];

/** When the first hold was placed. A renewed hold keeps the first one's expiry, 29 days after it (docs/paypal-sandbox-notes.md). */
export function originalHoldTime(r: Rental): string | null {
  if (!r.authorizedAt) return null;
  if (!r.parentAuthorizationId) return r.authorizedAt;
  if (r.authorizationExpiresAt) return new Date(ms(r.authorizationExpiresAt) - AUTHORIZATION_VALID_DAYS * DAY_MS).toISOString();
  return r.authorizedAt;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What went back to the renter on one of the settlement's captures, by the
 * rule refunds.ts uses for what is left to refund: the counter's refunds,
 * plus the larger of the refunds PayPal reported by webhook and the money a
 * dispute returned, because PayPal may report the same money both ways.
 */
function returnedOn(captureId: string, capturedCents: Cents, refunds: RefundRecord[], disputeCents: Cents) {
  const on = refunds.filter((r) => r.captureId === captureId && refundCounts(r));
  const counter = on.filter((r) => r.seq !== null).reduce((s, r) => s + r.amountCents, 0);
  const reported = on.filter((r) => r.seq === null).reduce((s, r) => s + r.amountCents, 0);
  const outside = Math.max(reported, disputeCents);
  const total = Math.min(capturedCents, counter + outside);
  // Attribute the dispute's share first, the rest to refunds.
  const dispute = Math.min(disputeCents, total);
  return { refunded: total - dispute, dispute };
}

// ─── Findings ────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  missing: "Missing",
  new_damage: "New damage",
  dirt: "Dirt",
  pre_existing: "Already there at pickup",
  wear: "Normal wear",
};

const DECISION_LABEL: Record<string, string> = { propose: "Proposed a charge", check: "Proposed, check it", note: "Note only" };

export function findingOutcome(f: ReviewedFinding, settled: boolean): { outcome: string; renter: string; staff: string } {
  const staff = f.staff === "waive" ? "Waived" : "Kept";
  const renter = f.customer === "accept" ? "Accepted" : f.customer === "contest" ? "Questioned" : "Not asked";
  if (f.decision === "note" || !f.price) return { outcome: "Note only, never charged", renter, staff };
  if (f.staff === "waive") return { outcome: "Waived by staff", renter, staff };
  if (f.customer === "contest") {
    if (f.resolution === "charge") return { outcome: settled ? "Charged after a question" : "Upheld after a question", renter, staff };
    if (f.resolution === "waive") return { outcome: "Waived after a question", renter, staff };
    return { outcome: "Questioned, waiting for staff", renter, staff };
  }
  if (f.customer === "accept") return { outcome: settled ? "Charged, renter accepted" : "Accepted, not settled yet", renter, staff };
  return { outcome: settled ? "Charged" : "Waiting for the renter", renter, staff };
}

// ─── Holds ───────────────────────────────────────────────────

export function holdRow(r: Rental, now: Date): HoldRow | null {
  if (!ACTIVE.includes(r.status) || !r.authorizationId || !r.authorizedCents) return null;
  const heldAt = originalHoldTime(r)!;
  const held = ms(heldAt);
  const expires = r.authorizationExpiresAt ? ms(r.authorizationExpiresAt) : held + AUTHORIZATION_VALID_DAYS * DAY_MS;
  const honorEnds = held + HONOR_PERIOD_DAYS * DAY_MS;
  const renewed = r.parentAuthorizationId ? r.authorizedAt : null;
  const due = renewalDueAt(new Date(held), r.endDate).getTime();
  const t = now.getTime();
  const daysLeft = Math.floor((expires - t) / DAY_MS);
  const today = now.toISOString().slice(0, 10);

  let state: string;
  if (t >= expires) state = "Expired";
  else if (renewed) state = "Renewed, keeps the first expiry";
  else if (t < honorEnds) state = "In the 72-hour honor period";
  else if (t >= due) state = "Renewal due now";
  else state = "Past 72 hours, renewal scheduled";

  const reasons: string[] = [];
  if (t >= expires) reasons.push("The hold has expired: PayPal can no longer capture it.");
  else if (expires - t < 3 * DAY_MS) reasons.push(`The hold expires in ${Math.max(0, daysLeft)} day${daysLeft === 1 ? "" : "s"}; settle before then.`);
  if (!renewed && t >= due + HOUR_MS && t < expires) reasons.push("Renewal was due over an hour ago and has not happened; check the hourly job.");
  if (r.status === "out" && r.endDate < today) reasons.push(`The item was due back on ${r.endDate}.`);
  if (r.status === "responded") reasons.push("The renter has answered; ready to settle.");

  return {
    rental_id: r.id,
    item: catalogItem(r.itemId).name,
    renter: firstName(r.customerName),
    authorization_id: r.authorizationId,
    original_authorization_id: r.parentAuthorizationId ?? r.authorizationId,
    amount_cents: r.authorizedCents,
    amount_usd: usd(r.authorizedCents),
    held_at: heldAt,
    honor_ends_at: new Date(honorEnds).toISOString(),
    renewal_due_at: new Date(due).toISOString(),
    renewed_at: renewed,
    expires_at: new Date(expires).toISOString(),
    due_back: r.endDate,
    hours_held: Math.max(0, Math.round(((t - held) / HOUR_MS) * 10) / 10),
    days_left: daysLeft,
    state,
    needs_attention: reasons.length > 0,
    attention: reasons.length ? reasons.join(" ") : null,
  };
}

// ─── The builder ─────────────────────────────────────────────

export function buildInsights(input: InsightsInput): InsightsData {
  const { now } = input;
  const thisMonth = month(now.toISOString());
  const rentals = input.rentals.filter((r) => r.status !== "draft");
  const refundsBy = groupBy(input.refunds, (r) => r.rentalId);
  const disputesBy = groupBy(input.disputes, (d) => d.rentalId);
  const photosBy = groupBy(input.photos, (p) => p.rentalId);
  const assessmentBy = new Map(input.assessments.map((a) => [a.rentalId, a]));

  const rentalRows: RentalRow[] = [];
  const ledger: LedgerRow[] = [];
  const findings: FindingRow[] = [];
  const holds: HoldRow[] = [];
  const timings: TimingRow[] = [];
  const flows: FlowRow[] = [];

  for (const r of rentals) {
    const item = catalogItem(r.itemId).name;
    const refunds = refundsBy.get(r.id) ?? [];
    const disputes = disputesBy.get(r.id) ?? [];
    const photos = photosBy.get(r.id) ?? [];
    const settled = SETTLED.includes(r.status) && r.settledAt !== null;
    const pickedUp = r.authorizationId !== null && r.authorizedCents !== null;
    const move = (m: Omit<LedgerRow, "rental_id" | "month" | "amount_usd" | "shop_net_usd" | "kind">) =>
      ledger.push({ ...m, rental_id: r.id, month: month(m.at), kind: LEDGER_KIND_LABEL[m.kind_code], amount_usd: usd(m.amount_cents), shop_net_usd: usd(m.shop_net_cents) });

    // The booking fee.
    if (feeTaken(r)) {
      move({ movement_id: `${r.id}:fee`, at: r.createdAt, kind_code: "fee_capture", paypal_id: r.feeCaptureId!, related_paypal_id: r.bookingOrderId, amount_cents: r.feeCents, shop_net_cents: r.feeCents, status: "COMPLETED" });
    }

    // The deposit hold, its renewal, and how it ended.
    const heldCents = pickedUp ? r.authorizedCents! : 0;
    const heldAt = originalHoldTime(r);
    if (pickedUp && heldAt) {
      const firstAuth = r.parentAuthorizationId ?? r.authorizationId!;
      move({ movement_id: `${r.id}:hold`, at: heldAt, kind_code: "deposit_hold", paypal_id: firstAuth, related_paypal_id: r.vaultId ? "saved PayPal wallet" : null, amount_cents: heldCents, shop_net_cents: 0, status: "CREATED" });
      if (r.parentAuthorizationId) {
        move({ movement_id: `${r.id}:renewal`, at: r.authorizedAt!, kind_code: "hold_renewal", paypal_id: r.authorizationId!, related_paypal_id: r.parentAuthorizationId, amount_cents: heldCents, shop_net_cents: 0, status: "CREATED" });
      }
    }
    const captured = settled ? (r.capturedCents ?? 0) : 0;
    const extra = settled ? (r.extraCents ?? 0) : 0;
    const released = settled ? (r.releasedCents ?? 0) : 0;
    if (settled && pickedUp) {
      const at = r.settledAt!;
      if (captured > 0 && r.settlementCaptureId) {
        move({ movement_id: `${r.id}:settle`, at, kind_code: "settlement_capture", paypal_id: r.settlementCaptureId, related_paypal_id: r.authorizationId, amount_cents: captured, shop_net_cents: captured, status: "COMPLETED" });
      }
      if (captured === 0) {
        move({ movement_id: `${r.id}:void`, at, kind_code: "void", paypal_id: r.authorizationId!, related_paypal_id: null, amount_cents: released, shop_net_cents: 0, status: "VOIDED" });
      } else if (released > 0) {
        move({ movement_id: `${r.id}:release`, at, kind_code: "release", paypal_id: r.authorizationId!, related_paypal_id: r.settlementCaptureId, amount_cents: released, shop_net_cents: 0, status: "Released with the final capture" });
      }
      if (extra > 0 && r.extraCaptureId) {
        move({ movement_id: `${r.id}:extra`, at, kind_code: "extra_charge", paypal_id: r.extraCaptureId, related_paypal_id: "saved PayPal wallet", amount_cents: extra, shop_net_cents: extra, status: "COMPLETED" });
      }
    }
    if (r.status === "cancelled" && pickedUp) {
      // A stray hold voided when the booking was cancelled (cancel.ts).
      move({ movement_id: `${r.id}:void`, at: r.cancelledAt ?? r.updatedAt, kind_code: "void", paypal_id: r.authorizationId!, related_paypal_id: null, amount_cents: heldCents, shop_net_cents: 0, status: "VOIDED" });
    }

    // Refunds: after settling, and of a cancelled booking's fee.
    for (const f of refunds) {
      const onFee = f.captureId === r.feeCaptureId;
      const counted = refundCounts(f);
      const status = f.state === "requested" ? "Sent, no answer from PayPal yet" : f.state === "refused" ? "Refused by PayPal" : (f.paypalStatus ?? "COMPLETED");
      if (f.state === "refused") continue;
      move({
        movement_id: `${r.id}:refund:${f.id}`,
        at: f.createdAt,
        kind_code: onFee && r.status === "cancelled" ? "cancellation_refund" : "refund",
        paypal_id: f.refundId ?? `pending refund ${f.seq ?? ""}`.trim(),
        related_paypal_id: f.captureId,
        amount_cents: f.amountCents,
        shop_net_cents: counted ? -f.amountCents : 0,
        status,
      });
    }

    // Disputes, from PayPal's fund movements; the outcome's refund when PayPal reported no movement.
    let disputeReturned = 0;
    for (const d of disputes) {
      const money = shopMoney({ fund_movements: d.fundMovements });
      const at = (m: { at: string | null } | null) => m?.at ?? d.openedAt ?? r.updatedAt;
      if (money.held) move({ movement_id: `${r.id}:dispute:${d.id}:held`, at: at(money.held), kind_code: "dispute_hold", paypal_id: d.id, related_paypal_id: d.transactionId, amount_cents: money.held.cents, shop_net_cents: 0, status: d.status });
      if (money.released) move({ movement_id: `${r.id}:dispute:${d.id}:released`, at: at(money.released), kind_code: "dispute_hold_released", paypal_id: d.id, related_paypal_id: d.transactionId, amount_cents: money.released.cents, shop_net_cents: 0, status: d.status });
      const payout = money.paidToCustomer?.cents ?? d.refundedCents ?? 0;
      if (payout > 0) {
        move({ movement_id: `${r.id}:dispute:${d.id}:payout`, at: at(money.paidToCustomer), kind_code: "dispute_payout", paypal_id: d.id, related_paypal_id: d.transactionId, amount_cents: payout, shop_net_cents: -payout, status: d.outcome ?? d.status });
      }
      if (money.fee) move({ movement_id: `${r.id}:dispute:${d.id}:fee`, at: at(money.fee), kind_code: "dispute_fee", paypal_id: d.id, related_paypal_id: d.transactionId, amount_cents: money.fee.cents, shop_net_cents: -money.fee.cents, status: d.status });
    }

    // What the shop keeps of the settlement's captures.
    let refundedAfter = 0;
    if (settled) {
      for (const [captureId, cents] of [
        [r.settlementCaptureId, captured],
        [r.extraCaptureId, extra],
      ] as const) {
        if (!captureId || cents <= 0) continue;
        const dispute = disputes.filter((d) => d.transactionId === captureId).reduce((s, d) => s + Math.max(0, d.refundedCents ?? 0), 0);
        const back = returnedOn(captureId, cents, refunds, dispute);
        refundedAfter += back.refunded;
        disputeReturned += back.dispute;
      }
    }
    const kept = captured + extra - refundedAfter - disputeReturned;
    const refundedAll = refunds.filter(refundCounts).reduce((s, f) => s + f.amountCents, 0);
    const cancellationRefund = refunds.filter((f) => refundCounts(f) && f.captureId === r.feeCaptureId && r.status === "cancelled").reduce((s, f) => s + f.amountCents, 0);
    const openDisputes = disputes.filter((d) => d.status !== "RESOLVED").length;
    const checkoutPhoto = photos.some((p) => p.phase === "checkout");

    rentalRows.push({
      rental_id: r.id,
      item,
      item_id: r.itemId,
      unit: r.unitId ? (input.units[r.unitId] ?? r.unitId) : null,
      renter: firstName(r.customerName),
      status: STATUS[r.status].label,
      status_code: r.status,
      start_date: r.startDate,
      end_date: r.endDate,
      days: r.days,
      booked_at: r.createdAt,
      booked_month: month(r.createdAt),
      settled_at: settled ? r.settledAt : null,
      settled_month: settled ? month(r.settledAt!) : null,
      fee_cents: r.feeCents,
      fee_usd: usd(r.feeCents),
      deposit_cents: r.depositCents,
      held_cents: heldCents,
      held_usd: usd(heldCents),
      captured_cents: captured,
      extra_cents: extra,
      released_cents: released,
      released_usd: usd(released),
      refunded_after_cents: refundedAfter,
      dispute_returned_cents: disputeReturned,
      kept_cents: kept,
      kept_usd: usd(kept),
      refunded_cents: refundedAll,
      refunded_usd: usd(refundedAll),
      cancellation_refund_cents: cancellationRefund,
      picked_up: pickedUp ? 1 : null,
      pickup_photographed: pickedUp ? (checkoutPhoto ? 1 : 0) : null,
      open_disputes: openDisputes,
    });

    // Where the deposit money went.
    const flow = (from: string, to: string, cents: number) => {
      if (cents > 0) flows.push({ rental_id: r.id, from, to, amount_cents: cents, amount_usd: usd(cents) });
    };
    if (pickedUp && ACTIVE.includes(r.status)) flow(FLOW.held, FLOW.stillHeld, heldCents);
    if (settled && pickedUp) {
      flow(FLOW.held, FLOW.released, released);
      flow(FLOW.held, FLOW.kept, captured);
      flow(FLOW.above, FLOW.kept, extra);
      flow(FLOW.kept, FLOW.refunded, refundedAfter);
      flow(FLOW.kept, FLOW.disputed, disputeReturned);
      flow(FLOW.kept, openDisputes > 0 ? FLOW.openDispute : FLOW.keptForGood, kept);
    }
    if (r.status === "cancelled" && pickedUp) flow(FLOW.held, FLOW.released, heldCents);

    // Findings of the latest assessment.
    const assessment = assessmentBy.get(r.id);
    for (const f of assessment?.findings ?? []) {
      const { outcome, renter, staff } = findingOutcome(f, settled);
      const chargeable = f.decision !== "note" && f.price !== null;
      const charged = settled && isCharged(f) ? f.price!.cents : 0;
      findings.push({
        finding_id: `${r.id}:${f.id}`,
        rental_id: r.id,
        item,
        found: f.item,
        kind: KIND_LABEL[f.kind] ?? f.kind,
        confidence: f.confidence,
        price_entry: f.price?.label ?? null,
        price_id: f.price?.id ?? null,
        ai_decision: DECISION_LABEL[f.decision] ?? f.decision,
        proposed_cents: chargeable ? f.price!.cents : 0,
        proposed_usd: usd(chargeable ? f.price!.cents : 0),
        staff_decision: staff,
        renter_answer: renter,
        final_outcome: outcome,
        charged_cents: charged,
        charged_usd: usd(charged),
      });
    }

    const hold = holdRow(r, now);
    if (hold) holds.push(hold);

    const returnPhoto = photos.filter((p) => p.phase === "checkin").map((p) => p.takenAt).sort().at(-1) ?? null;
    timings.push({
      rental_id: r.id,
      booked_at: r.createdAt,
      pickup_at: heldAt,
      return_photo_at: returnPhoto,
      settled_at: settled ? r.settledAt : null,
      hours_booking_to_pickup: heldAt ? round1((ms(heldAt) - ms(r.createdAt)) / HOUR_MS) : null,
      minutes_return_to_settled: settled && returnPhoto ? round1((ms(r.settledAt!) - ms(returnPhoto)) / 60_000) : null,
    });
  }

  ledger.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.movement_id.localeCompare(b.movement_id)));
  const pickups = rentalRows.filter((r) => r.picked_up === 1);
  const photographed = pickups.filter((r) => r.pickup_photographed === 1).length;
  const settledMinutes = timings.flatMap((t) => (t.minutes_return_to_settled === null ? [] : [Math.max(0, t.minutes_return_to_settled)]));

  return {
    rentals: rentalRows,
    ledger,
    findings,
    holds,
    timings,
    flows,
    summary: {
      generated_at: now.toISOString(),
      held_now_cents: holds.reduce((s, h) => s + h.amount_cents, 0),
      kept_this_month_cents: rentalRows.filter((r) => r.settled_month === thisMonth).reduce((s, r) => s + r.kept_cents, 0),
      released_cents: rentalRows.reduce((s, r) => s + r.released_cents, 0),
      refunded_cents: rentalRows.reduce((s, r) => s + r.refunded_cents, 0),
      open_disputes: rentalRows.reduce((s, r) => s + r.open_disputes, 0),
      pickups: pickups.length,
      pickups_photographed: photographed,
      pickups_photographed_share: pickups.length ? photographed / pickups.length : null,
      before_share_low: 0.3,
      before_share_high: 0.4,
      settled_with_return_photo: settledMinutes.length,
      median_minutes_return_to_settled: median(settledMinutes),
      holds_needing_attention: holds.filter((h) => h.needs_attention).length,
    },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}
