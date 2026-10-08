import type { AgDataRelationDefinition, AgFieldDefinition } from "ag-studio";
import { SHOP } from "@/lib/shop";
import { LEDGER_KIND_LABEL, type InsightsData } from "./model";

/**
 * The dashboard's tables as AG Studio data sources: one source per table,
 * with a name, a description for people and the AI, and field definitions
 * whose descriptions say what each number means. Plain JSON, so the server
 * can hand it to the page; the page turns date strings into Date objects
 * (hydrateSources) before giving it to Studio.
 */

type Field = Pick<AgFieldDefinition, "id" | "name" | "description" | "format" | "formatOptions" | "hide">;

export type SourceSpec = {
  id: string;
  name: string;
  description: string;
  fields: Field[];
  data: Record<string, string | number | boolean | null>[];
};

export type StudioDataSpec = {
  description: string;
  sources: SourceSpec[];
  relationships: AgDataRelationDefinition[];
};

const USD = { format: "$#,##0.00" };

const text = (id: string, name: string, description: string, hide = false): Field => ({ id, name, description, format: "textFormat", hide });
const usd = (id: string, name: string, description: string): Field => ({ id, name, description, format: "currencyFormat", formatOptions: USD });
const cents = (id: string, name: string, description: string, hide = true): Field => ({
  id,
  name,
  description: `${description} Integer cents (100 = $1.00).`,
  format: "integerFormat",
  formatOptions: { format: "#,##0" },
  hide,
});
const int = (id: string, name: string, description: string): Field => ({ id, name, description, format: "integerFormat", formatOptions: { format: "#,##0" } });
const num = (id: string, name: string, description: string): Field => ({ id, name, description, format: "decimalFormat", formatOptions: { format: "#,##0.0" } });
const pct = (id: string, name: string, description: string): Field => ({ id, name, description, format: "percentageFormat", formatOptions: { format: "#,##0%" } });
const day = (id: string, name: string, description: string): Field => ({ id, name, description, format: "dateFormat" });
const time = (id: string, name: string, description: string): Field => ({ id, name, description, format: "dateTimeFormat" });
const bool = (id: string, name: string, description: string): Field => ({ id, name, description, format: "booleanFormat" });

const rel = (from: string, type: AgDataRelationDefinition["type"]): AgDataRelationDefinition => ({
  id: `${from}-rentals`,
  source: { tableId: from, fieldId: "rental_id" },
  target: { tableId: "rentals", fieldId: "rental_id" },
  type,
});

const RENTAL_ID = (what: string) => text("rental_id", "Rental", `The rental this ${what} belongs to, e.g. R-7KQ2MX. Joins to Rentals.`);

export function studioData(d: InsightsData): StudioDataSpec {
  const kinds = Object.values(LEDGER_KIND_LABEL).join("; ");
  return {
    description:
      `Deposits and payments of one small rental shop (${SHOP.name}) that takes the rental fee with PayPal at booking, holds a refundable deposit on the renter's saved PayPal account at pickup, and at return keeps only the repair charges the renter accepted or staff upheld, releasing the rest of the hold. Every amount comes from PayPal movements the app recorded; nothing here is an estimate. Dollar fields are for display; the ledger also carries exact integer cents. Renters appear by first name only. Times are UTC.`,
    relationships: [rel("ledger", "many-to-one"), rel("findings", "many-to-one"), rel("holds", "one-to-one"), rel("timings", "one-to-one"), rel("flows", "many-to-one")],
    sources: [
      {
        id: "rentals",
        name: "Rentals",
        description: "One row per booking that was paid or went further (unpaid drafts are left out): the item, dates, status and what happened to its deposit.",
        fields: [
          text("rental_id", "Rental", "The rental's id, e.g. R-7KQ2MX."),
          text("item", "Item", "What was rented, from the shop's catalog."),
          text("item_id", "Item id", "Catalog id of the item.", true),
          text("unit", "Unit", "The physical unit handed over, e.g. Camera kit B."),
          text("renter", "Renter", "The renter's first name only, reduced to letters, apostrophes and hyphens."),
          text("status", "Status", "Where the rental is now: Booked, Out (deposit held), Needs review, With customer, Customer answered, Settled, Cancelled or Disputed."),
          text("status_code", "Status code", "Machine status: booked, out, inspecting, customer_review, responded, settled, cancelled, disputed.", true),
          day("start_date", "Pickup day", "Day the item is picked up (UTC)."),
          day("end_date", "Return day", "Day the item is due back (UTC)."),
          int("days", "Days", "Length of the rental in days."),
          time("booked_at", "Booked at", "When the booking was made."),
          text("booked_month", "Booked month", "Month the booking was made, as YYYY-MM."),
          time("settled_at", "Settled at", "When the deposit was settled: the final capture, or the void when nothing was owed. Empty until then."),
          text("settled_month", "Settled month", "Month the deposit was settled, as YYYY-MM. Empty until settled."),
          usd("fee_usd", "Rental fee", "Rental fee the renter paid with PayPal at booking."),
          usd("held_usd", "Deposit held", "Deposit held on PayPal at pickup (an authorization: reserved, not taken). Zero if the item was never picked up."),
          usd("released_usd", "Released", "Part of the deposit hold PayPal released back to the renter at settlement (all of it when nothing was owed)."),
          usd("kept_usd", "Kept", "What the shop keeps of the deposit and of any charge above it, after later refunds and money a PayPal dispute gave back."),
          usd("refunded_usd", "Refunded", "Every completed PayPal refund on the rental: after settling, and of a cancelled booking's fee."),
          cents("held_cents", "Deposit held (cents)", "Deposit held at pickup."),
          cents("captured_cents", "Captured from hold (cents)", "Taken from the deposit hold by the final capture."),
          cents("extra_cents", "Charged above deposit (cents)", "Repairs above the deposit, charged to the saved PayPal account."),
          cents("released_cents", "Released (cents)", "Released from the hold at settlement."),
          cents("refunded_after_cents", "Refunded after settling (cents)", "Refunded of what the settlement took."),
          cents("dispute_returned_cents", "Returned in a dispute (cents)", "Given back through a PayPal dispute on the settlement."),
          cents("kept_cents", "Kept (cents)", "What the shop keeps after refunds and disputes."),
          cents("refunded_cents", "Refunded (cents)", "Every completed refund, the fee included."),
          cents("cancellation_refund_cents", "Cancellation refund (cents)", "Fee refunded when the booking was cancelled before pickup."),
          int("picked_up", "Picked up", "1 when the deposit was held at pickup; empty when the item never left."),
          pct("pickup_photographed", "Pickup photographed", "1 (100%) when the item left with a pickup photo on record, 0 when without; empty when not picked up. Average it for the share of pickups photographed. The counter cannot hold a deposit without a pickup photo."),
          int("open_disputes", "Open disputes", "PayPal disputes on this rental that PayPal has not closed yet."),
        ],
        data: d.rentals,
      },
      {
        id: "ledger",
        name: "PayPal ledger",
        description: `One row per money movement on PayPal, newest first. Kinds: ${kinds}. A hold reserves money without taking it; a release or void gives a hold back. shop_net is the signed effect on the shop's PayPal balance. When PayPal reports money a dispute paid back a second time as a refund, that refund row is listed with a net of 0, so the money counts once.`,
        fields: [
          text("movement_id", "Movement", "Unique id of this row.", true),
          RENTAL_ID("movement"),
          time("at", "When", "When the movement happened (UTC)."),
          text("month", "Month", "Month of the movement, as YYYY-MM."),
          text("kind", "Movement", "What PayPal did, in words."),
          text("kind_code", "Kind code", "Machine kind: fee_capture, deposit_hold, hold_renewal, settlement_capture, extra_charge, release, void, refund, fee_refund, cancellation_refund, dispute_hold, dispute_hold_released, dispute_payout, dispute_fee.", true),
          text("paypal_id", "PayPal id", "PayPal's id for this movement: a capture, authorization, refund or dispute id. Search it in PayPal's dashboard."),
          text("related_paypal_id", "Acts on", "The PayPal id this movement acts on: the hold a capture or release came from, the capture a refund returns."),
          cents("amount_cents", "Amount (cents)", "Size of the movement.", false),
          usd("amount_usd", "Amount", "Size of the movement in dollars."),
          int("shop_net_cents", "Net to shop (cents)", "Signed effect on the shop's balance in integer cents: positive when money was taken, negative when given back or paid out, 0 for holds and releases."),
          usd("shop_net_usd", "Net to shop", "Signed effect on the shop's balance: positive when money was taken, negative when given back or paid out, 0 for holds and releases."),
          text("status", "PayPal status", "Status PayPal reported, or what the app knows (for example a refund sent with no answer yet)."),
        ],
        data: d.ledger,
      },
      {
        id: "findings",
        name: "Findings",
        description:
          "One row per thing the two Gemini looks found when comparing the pickup and return photos, priced by code from the shop's repair list (the model never names an amount). Shows what staff decided, how the renter answered on their phone, and the outcome.",
        fields: [
          text("finding_id", "Finding", "Unique id of the finding."),
          RENTAL_ID("finding"),
          text("item", "Item", "What was rented."),
          text("found", "What was found", "The part of the item the finding is about, e.g. lens hood."),
          text("kind", "Kind", "Missing, New damage, Dirt (chargeable), or Already there at pickup / Normal wear (never charged)."),
          text("confidence", "Confidence", "The lower of the two looks' confidence: high, medium or low."),
          text("price_entry", "Price-list entry", "The repair-list entry the finding points at, e.g. Replace lens hood. Empty for notes."),
          text("price_id", "Price id", "Id of the price-list entry.", true),
          text("ai_decision", "Proposal", "What the pricing policy did: proposed a charge, proposed it with a check, or kept it as a note."),
          usd("proposed_usd", "Proposed", "Price-list amount proposed for this finding; zero for notes."),
          text("staff_decision", "Staff", "Kept or Waived by staff before the renter saw it."),
          text("renter_answer", "Renter's answer", "Accepted, Questioned, or Not asked."),
          text("final_outcome", "Outcome", "How it ended: charged (accepted or after a question), waived by staff, waived after a question, note only, or still waiting."),
          usd("charged_usd", "Charged", "Amount actually charged for this finding at settlement."),
          cents("proposed_cents", "Proposed (cents)", "Price-list amount proposed."),
          cents("charged_cents", "Charged (cents)", "Amount charged at settlement."),
        ],
        data: d.findings,
      },
      {
        id: "holds",
        name: "Active holds",
        description:
          "Deposit holds running now. PayPal keeps a hold for 29 days from the first authorization; from 72 hours (the honor period) it may be renewed once, and a renewed hold keeps the first one's expiry. The app renews the day before the item is due back, never before 72 hours.",
        fields: [
          RENTAL_ID("hold"),
          text("item", "Item", "What was rented."),
          text("renter", "Renter", "The renter's first name."),
          text("authorization_id", "Authorization", "PayPal authorization id the shop would capture from now."),
          text("original_authorization_id", "First authorization", "PayPal id of the first hold; differs from Authorization after a renewal."),
          usd("amount_usd", "Held", "Amount held."),
          cents("amount_cents", "Held (cents)", "Amount held."),
          time("held_at", "Held at", "When the first hold was placed (the start of PayPal's 29 days)."),
          time("honor_ends_at", "Honor period ends", "72 hours after the first hold: renewal is allowed from here."),
          time("renewal_due_at", "Renewal due", "When the app's hourly job renews the hold."),
          time("renewed_at", "Renewed at", "When the hold was renewed, if it was."),
          time("expires_at", "Expires", "When PayPal's hold expires; a renewal does not move it."),
          day("due_back", "Due back", "Day the item is due back."),
          num("hours_held", "Hours held", "Hours since the first hold."),
          int("days_left", "Days left", "Whole days until the hold expires."),
          text("state", "Hold state", "In the honor period, past 72 hours with renewal scheduled, renewal due now, renewed, or expired."),
          bool("needs_attention", "Needs attention", "True when the hold expires within 3 days, a renewal was missed, the item is overdue, or the renter answered and it can be settled."),
          text("attention", "Why", "What needs doing, in words."),
        ],
        data: d.holds,
      },
      {
        id: "timings",
        name: "Timings",
        description: "How long the steps took, per rental.",
        fields: [
          RENTAL_ID("timing"),
          time("booked_at", "Booked at", "When the booking was made."),
          time("pickup_at", "Picked up at", "When the deposit was held at pickup."),
          time("return_photo_at", "Return photo at", "When the return photo was taken."),
          time("settled_at", "Settled at", "When the deposit was settled (captured and released, or voided)."),
          num("hours_booking_to_pickup", "Hours booking to pickup", "Hours from booking to the deposit hold at pickup."),
          num("minutes_return_to_settled", "Minutes return to settled", "Minutes from the return photo to the deposit being settled, which is when PayPal releases what was not kept."),
        ],
        data: d.timings,
      },
      {
        id: "flows",
        name: "Deposit flows",
        description:
          "Where deposit money went, as from-to flows per rental: Deposits held to Released to renters, Captured for repairs or Still held; Charged above the deposit to Captured for repairs; Captured for repairs to Refunded later, Returned in a dispute, In an open dispute or Kept by the shop. Money is conserved at every node.",
        fields: [
          RENTAL_ID("flow"),
          text("from", "From", "Where the money came from."),
          text("to", "To", "Where it went."),
          usd("amount_usd", "Amount", "Money on this flow."),
          cents("amount_cents", "Amount (cents)", "Money on this flow."),
        ],
        data: d.flows,
      },
      {
        id: "summary",
        name: "Summary",
        description: "One row of figures that are not sums of the other tables: medians and shares, as of the time the page loaded.",
        fields: [
          time("generated_at", "As of", "When these figures were computed."),
          num("median_minutes_return_to_settled", "Median minutes, return photo to released", "Median minutes from the return photo to the deposit being settled, over settled rentals with a return photo."),
          int("settled_with_return_photo", "Settled with a return photo", "How many rentals the median covers."),
          pct("pickups_photographed_share", "Pickups photographed", "Share of pickups with a pickup photo on record."),
          pct("before_share_low", "Photographed before (low)", "The interviewed bike shop's own estimate of pickups it photographed before: 30%."),
          pct("before_share_high", "Photographed before (high)", "The same estimate's upper end: 40%."),
          int("holds_needing_attention", "Holds needing attention", "Active holds that need a person now."),
        ],
        data: [
          {
            generated_at: d.summary.generated_at,
            median_minutes_return_to_settled: d.summary.median_minutes_return_to_settled,
            settled_with_return_photo: d.summary.settled_with_return_photo,
            pickups_photographed_share: d.summary.pickups_photographed_share,
            before_share_low: d.summary.before_share_low,
            before_share_high: d.summary.before_share_high,
            holds_needing_attention: d.summary.holds_needing_attention,
          },
        ],
      },
    ],
  };
}
