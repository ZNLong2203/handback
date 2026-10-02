import "server-only";
import { z } from "zod";
import { CATALOG } from "@/lib/catalog";
import { todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { formatUsd, type Cents } from "@/lib/money";
import { DepositMandateSchema, mandateExpiry, mandateTerms } from "@/lib/rentals/mandate";
import { latestAssessment, rentalByToken } from "@/lib/rentals/repo";
import * as svc from "@/lib/rentals/service";
import { awaitingCustomer } from "@/lib/rentals/settlement";
import { STATUS } from "@/lib/rentals/status";
import { RENTAL_STATUSES, UserError, type Rental } from "@/lib/rentals/types";
import { SHOP } from "@/lib/shop";

// The tools an assistant gets. They read the catalog, price a rental, start
// a booking and report on it. None of them moves money: the renter approves
// the fee in PayPal, and only the renter (on their page) and the counter
// (at the shop) can act on charges.

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
  assistant: z.string().trim().min(1).max(60).optional().describe("Your name as an assistant, e.g. Claude. Shown to the renter; not verified."),
});

export const StatusArgs = z.object({
  token: z.string().min(10).max(300).describe("The rental's private token: the part after /r/ in rentalPageUrl, or the whole URL"),
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
  rentalPageUrl: z.string(),
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
  rentalPageUrl: z.string(),
  amounts: z.object({
    fee: Money,
    feePaid: z.boolean(),
    depositHold: Money,
    heldNow: Money.nullable(),
    kept: Money.nullable(),
    released: Money.nullable(),
    chargedAboveHold: Money.nullable(),
  }),
  /** Proposed charges the renter has to accept or question, on their own page. */
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
  if (!b.approveUrl) throw new UserError("PayPal did not return an approval link for this booking. Try again in a moment.");
  return {
    rentalId: b.rentalId,
    status: "awaiting_renter_approval",
    approveUrl: b.approveUrl,
    rentalPageUrl: svc.rentalPageUrl(b.token),
    payNow: money(b.mandate.feeCents),
    depositHold: money(b.mandate.hold.maxCents),
    mandate: b.mandate,
    mandateSha256: b.mandateSha256,
    terms: mandateTerms(b.mandate),
    nextStep:
      `Give ${input.name} the approveUrl. They approve the ${formatUsd(b.mandate.feeCents)} rental fee in PayPal themselves, which also ` +
      `saves their PayPal for the deposit hold at pickup; nothing is paid until they do. PayPal expects the link to be opened within ` +
      `6 hours. rentalPageUrl is their private page for this rental, with the mandate; treat it like a password.`,
  };
}

/** Accepts the bare token or the whole rental page URL. */
function tokenFrom(input: string): string {
  return /\/r\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();
}

function nextStepFor(rental: Rental, pageUrl: string): string {
  const steps: Record<Rental["status"], string> = {
    draft: "Waiting for the renter to approve the booking in PayPal. If they lost the link, give them approveUrl again.",
    booked: `Booked and paid. The renter picks the item up on ${rental.startDate}; the shop photographs it and holds the deposit then.`,
    out: `The item is out and the deposit is held, not charged. It is due back on ${rental.endDate}.`,
    inspecting: "The shop is comparing the return photo with the pickup photo. Any proposed charge goes to the renter before anything is taken.",
    customer_review: `The shop proposes the charges in waitingForRenter. Only the renter can accept or question them, on their own page: ${pageUrl}`,
    responded: "The renter has answered. A person at the shop settles next; nothing more is needed from the renter.",
    settled: "Settled. Nothing more to do.",
    cancelled: "This booking was cancelled.",
    disputed: "The renter opened a PayPal dispute about this rental; PayPal handles it from here.",
  };
  return steps[rental.status];
}

export async function rentalStatus(args: z.infer<typeof StatusArgs>): Promise<z.infer<typeof StatusOut>> {
  const db = await getDb();
  const rental = await rentalByToken(db, tokenFrom(args.token));
  if (!rental) throw new UserError("No rental has that token. Use the token from the rentalPageUrl that create_booking returned.");
  const item = CATALOG.find((i) => i.id === rental.itemId);
  const assessment = rental.status === "customer_review" ? await latestAssessment(db, rental.id) : null;
  const pageUrl = svc.rentalPageUrl(rental.token);
  const settled = rental.status === "settled";
  return {
    rentalId: rental.id,
    item: { id: rental.itemId, name: item?.name ?? rental.itemId },
    pickup: rental.startDate,
    return: rental.endDate,
    status: rental.status,
    statusLabel: STATUS[rental.status].customerLabel ?? STATUS[rental.status].label,
    explanation: STATUS[rental.status].customer,
    nextStep: nextStepFor(rental, pageUrl),
    approveUrl: rental.status === "draft" ? rental.approveUrl : null,
    rentalPageUrl: pageUrl,
    amounts: {
      fee: money(rental.feeCents),
      feePaid: rental.feeCaptureId !== null,
      depositHold: money(rental.depositCents),
      heldNow: rental.authorizedCents && !settled ? money(rental.authorizedCents) : null,
      kept: settled ? money(rental.capturedCents ?? 0) : null,
      released: settled ? money(rental.releasedCents ?? 0) : null,
      chargedAboveHold: settled && rental.extraCents ? money(rental.extraCents) : null,
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
