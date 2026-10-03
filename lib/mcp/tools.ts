import "server-only";
import { z } from "zod";
import { CATALOG } from "@/lib/catalog";
import { todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { formatUsd, type Cents } from "@/lib/money";
import { DepositMandateSchema, mandateExpiry, mandateTerms } from "@/lib/rentals/mandate";
import { refundedCents, refundsFor } from "@/lib/rentals/refunds";
import { latestAssessment, rentalByStatusToken } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import { feePending, STATUS } from "@/lib/rentals/status";
import { RENTAL_STATUSES, UserError, type Rental } from "@/lib/rentals/types";
import { SHOP } from "@/lib/shop";

// The tools an assistant gets. They read the catalog, price a rental, start
// a booking and report on it. None of them moves money or answers for the
// renter: the renter approves the fee in PayPal and answers charges on their
// own page, and the counter holds and settles the deposit. The assistant
// never gets the renter's page token; it follows the rental with a status
// token that can only read.

/** Money for assistants: exact cents to compute with, and the amount as people read it. */
const Money = z.object({ cents: z.number().int(), usd: z.string() });
const money = (cents: Cents) => ({ cents, usd: formatUsd(cents) });

const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe(`${what}, as YYYY-MM-DD`);

// ─── Inputs ─────────────────────────────────────────────────

export const QuoteArgs = z.object({
  itemId: z.string().min(1).max(40).describe("Item id from list_items, e.g. drone-kit"),
  startDate: isoDate("Pickup date"),
  endDate: isoDate("Return date"),
});

export const BookingArgs = QuoteArgs.extend({
  name: z.string().trim().min(1).max(80).describe("The renter's full name, as they gave it"),
  email: z.string().trim().email().describe("The renter's email address"),
  assistant: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("What you call yourself, so the renter knows which assistant booked for them. Leave it out rather than guess. Shown to the renter; not verified."),
});

export const StatusArgs = z.object({
  statusToken: z.string().min(10).max(100).describe("The statusToken that create_booking returned"),
});

// ─── Outputs ────────────────────────────────────────────────

const Price = z.object({ id: z.string(), label: z.string(), kind: z.string(), price: Money });

export const ListItemsOut = z.object({
  shop: z.object({ name: z.string(), city: z.string(), today: z.string(), maxRentalDays: z.number().int() }),
  items: z.array(
    z.object({ id: z.string(), name: z.string(), category: z.string(), dailyRate: Money, depositHold: Money, kit: z.array(z.string()) }),
  ),
});

export const QuoteOut = z.object({
  item: z.object({ id: z.string(), name: z.string() }),
  pickup: z.string(),
  return: z.string(),
  days: z.number().int(),
  /** The rental fee, paid when the renter approves in PayPal. */
  payNow: Money,
  /** Held at pickup on the renter's PayPal, not charged. */
  depositHold: Money,
  priceList: z.array(Price),
  terms: z.array(z.string()),
});

export const BookingOut = z.object({
  rentalId: z.string(),
  status: z.literal("awaiting_renter_approval"),
  approveUrl: z.string(),
  /** Read-only: for get_rental_status. */
  statusToken: z.string(),
  payNow: Money,
  depositHold: Money,
  mandate: DepositMandateSchema,
  mandateSha256: z.string(),
  terms: z.array(z.string()),
  nextStep: z.string(),
});

export const StatusOut = z.object({
  rentalId: z.string(),
  item: z.object({ id: z.string(), name: z.string() }),
  pickup: z.string(),
  return: z.string(),
  status: z.enum(RENTAL_STATUSES),
  statusLabel: z.string(),
  explanation: z.string(),
  nextStep: z.string(),
  /** Only while the renter still has to approve in PayPal. */
  approveUrl: z.string().nullable(),
  amounts: z.object({
    fee: Money,
    feePaid: z.boolean(),
    /** Approved, but PayPal left the capture PENDING; the booking is confirmed when it completes. */
    feePending: z.boolean(),
    depositHold: Money,
    heldNow: Money.nullable(),
    kept: Money.nullable(),
    released: Money.nullable(),
    chargedAboveHold: Money.nullable(),
    /** Refunded on PayPal after payment, of the fee or of what the settlement kept; null when nothing was. */
    refunded: Money.nullable(),
  }),
  /** Proposed charges the renter has to accept or question, on their own page; no tool can answer them. */
  waitingForRenter: z.array(z.object({ findingId: z.string(), item: z.string(), description: z.string(), charge: z.string(), price: Money })),
  mandateSha256: z.string().nullable(),
});

// ─── Handlers ───────────────────────────────────────────────

export function listItems(): z.infer<typeof ListItemsOut> {
  return {
    shop: { name: SHOP.name, city: SHOP.city, today: todayIso(), maxRentalDays: SHOP.maxRentalDays },
    items: CATALOG.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      dailyRate: money(i.dailyCents),
      depositHold: money(i.depositCents),
      kit: i.kit,
    })),
  };
}

export function quoteRental(args: z.infer<typeof QuoteArgs>): z.infer<typeof QuoteOut> {
  const q = svc.quoteRental(args);
  return {
    item: { id: q.item.id, name: q.item.name },
    pickup: q.startDate,
    return: q.endDate,
    days: q.days,
    payNow: money(q.feeCents),
    depositHold: money(q.depositCents),
    priceList: q.item.prices.map((p) => ({ id: p.id, label: p.label, kind: p.kind, price: money(p.cents) })),
    terms: mandateTerms({ feeCents: q.feeCents, hold: { maxCents: q.depositCents, starts: "at_pickup" }, expiresAt: mandateExpiry(q.startDate) }),
  };
}

export async function createBooking(args: z.infer<typeof BookingArgs>): Promise<z.infer<typeof BookingOut>> {
  const { assistant, ...input } = args;
  const b = await svc.startBooking(input, { party: "assistant", assistant: assistant ?? null });
  if (!b.approveUrl || !b.statusToken) throw new UserError("PayPal did not return an approval link for this booking. Try again in a moment.");
  return {
    rentalId: b.rentalId,
    status: "awaiting_renter_approval",
    approveUrl: b.approveUrl,
    statusToken: b.statusToken,
    payNow: money(b.mandate.feeCents),
    depositHold: money(b.mandate.hold.maxCents),
    mandate: b.mandate,
    mandateSha256: b.mandateSha256,
    terms: mandateTerms(b.mandate),
    nextStep:
      `Give ${input.name} the approveUrl, and only them. They approve the ${formatUsd(b.mandate.feeCents)} rental fee in PayPal themselves, ` +
      `which also saves their PayPal for the deposit hold at pickup; nothing is paid until they do. PayPal expects the link to be opened ` +
      `within 6 hours. After they approve, PayPal opens their private rental page, where they answer any charges later; you do not get ` +
      `that page. Use statusToken with get_rental_status to see where the rental stands.`,
  };
}

function nextStepFor(rental: Rental): string {
  if (feePending(rental)) return "The renter approved in PayPal. PayPal is still processing the rental fee; the booking is confirmed when it completes.";
  const steps: Record<Rental["status"], string> = {
    draft: "Waiting for the renter to approve the booking in PayPal. If they lost the link, give them approveUrl again.",
    booked: `Booked and paid. The renter picks the item up on ${rental.startDate}; the shop photographs it and holds the deposit then.`,
    out: `The item is out and the deposit is held, not charged. It is due back on ${rental.endDate}.`,
    inspecting: "The shop is comparing the return photo with the pickup photo. Any proposed charge goes to the renter before anything is taken.",
    customer_review:
      "The shop proposes the charges in waitingForRenter. The renter accepts or questions each one on their own rental page, the one PayPal " +
      "opened after they paid; the shop can show them its link again. No tool can answer for them.",
    responded: "The renter has answered. A person at the shop settles next; nothing more is needed from the renter.",
    settled: "Settled. Nothing more to do.",
    cancelled: "This booking was cancelled; nothing more happens on it. The renter can book again.",
    disputed: "The renter opened a PayPal dispute about this rental; PayPal handles it from here.",
  };
  return steps[rental.status];
}

export async function rentalStatus(args: z.infer<typeof StatusArgs>): Promise<z.infer<typeof StatusOut>> {
  const db = await getDb();
  const rental = await rentalByStatusToken(db, args.statusToken.trim());
  if (!rental) throw new UserError("No rental has that status token. Use the statusToken that create_booking returned.");
  const item = CATALOG.find((i) => i.id === rental.itemId);
  const assessment = rental.status === "customer_review" ? await latestAssessment(db, rental.id) : null;
  // Follow the money, not the status: a dispute can come before or after
  // settlement, and PayPal holds the deposit from pickup until settlement.
  const settled = rental.settledAt !== null;
  const holding = !settled && rental.authorizationId !== null && rental.authorizedCents !== null;
  const processing = feePending(rental);
  const refunded = settled ? refundedCents(await refundsFor(db, rental.id)) : 0;
  return {
    rentalId: rental.id,
    item: { id: rental.itemId, name: item?.name ?? rental.itemId },
    pickup: rental.startDate,
    return: rental.endDate,
    status: rental.status,
    statusLabel: STATUS[rental.status].customerLabel ?? STATUS[rental.status].label,
    explanation: processing ? "PayPal is still processing the renter's payment." : STATUS[rental.status].customer,
    nextStep: nextStepFor(rental),
    approveUrl: rental.status === "draft" && !processing ? rental.approveUrl : null,
    amounts: {
      fee: money(rental.feeCents),
      feePaid: rental.feeCaptureId !== null && rental.status !== "draft" && rental.status !== "cancelled",
      feePending: processing,
      depositHold: money(rental.depositCents),
      heldNow: holding ? money(rental.authorizedCents!) : null,
      kept: settled ? money(rental.capturedCents ?? 0) : null,
      released: settled ? money(rental.releasedCents ?? 0) : null,
      chargedAboveHold: settled && rental.extraCents ? money(rental.extraCents) : null,
      refunded: refunded > 0 ? money(refunded) : null,
    },
    waitingForRenter: assessment
      ? awaitingCustomer(assessment.findings).map((f) => ({
          findingId: f.id,
          item: f.item,
          description: f.description,
          charge: f.price!.label,
          price: money(f.price!.cents),
        }))
      : [],
    mandateSha256: rental.mandateSha256,
  };
}
