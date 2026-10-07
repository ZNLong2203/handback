import { createHash } from "node:crypto";
import { z } from "zod";
import type { RentalItem } from "@/lib/catalog";
import { addDaysIso, shortDate } from "@/lib/dates";
import { formatUsd, type Cents } from "@/lib/money";
import { AUTHORIZATION_VALID_DAYS } from "@/lib/paypal/gateway";
import { canonicalJson, firstBrokenLink } from "./audit";
import { cancellationTerms, termsSummary, type CancellationTerms } from "./cancellation";
import type { AuditEvent, Rental } from "./types";

// The deposit mandate: what the renter allows the shop to do with their
// PayPal account, written down when the booking starts and approved by the
// renter in PayPal. The shape borrows the idea of AP2's mandates (a scoped,
// expiring, hashable statement of what may be charged); it is not an AP2
// implementation and carries no signature.

const cents = z.number().int().nonnegative();

const MandateV1 = z.object({
  type: z.literal("handback.deposit-mandate"),
  version: z.literal(1),
  rentalId: z.string(),
  shop: z.object({ name: z.string(), city: z.string() }),
  item: z.object({ id: z.string(), name: z.string() }),
  renter: z.object({ name: z.string(), email: z.string() }),
  /** Who the shop handed this mandate to: the renter on the website, or an assistant acting for them. */
  issuedTo: z.discriminatedUnion("party", [
    z.object({ party: z.literal("renter") }),
    z.object({
      party: z.literal("assistant"),
      /** The assistant's own name for itself. Self-reported, not verified. */
      assistant: z.string().nullable(),
      actingFor: z.string(),
    }),
  ]),
  period: z.object({ pickup: z.string(), return: z.string(), days: z.number().int().positive() }),
  currency: z.literal("USD"),
  /** The rental fee, captured when the renter approves in PayPal. */
  feeCents: cents,
  /** The most the shop may hold, starting when the item leaves the shop. */
  hold: z.object({ maxCents: cents, starts: z.literal("at_pickup") }),
  /** The rules for charging, as the code applies them (settle in service.ts). */
  charges: z.object({
    from: z.literal("price_list"),
    onlyAfter: z.literal("shown_to_renter"),
    accepted: z.literal("charged"),
    questioned: z.literal("shop_decides"),
    aboveHold: z.literal("saved_paypal"),
  }),
  priceList: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(["missing", "damage", "dirt"]), cents })),
  /** Nothing can be held or charged under this mandate from this moment on. */
  expiresAt: z.string(),
  createdAt: z.string(),
});

/**
 * Version 2 adds the cancellation terms. Mandates issued before it stay
 * version 1, without them, and still verify byte for byte: their text is
 * never rewritten.
 */
const MandateV2 = MandateV1.extend({
  version: z.literal(2),
  /** The share of the rental fee refunded when the renter cancels before each moment (UTC, earliest first); from the last one, the pickup day, nothing. */
  cancellation: z.object({ feeRefund: z.array(z.object({ before: z.string(), percent: z.number().int().min(0).max(100) })) }),
});

export const DepositMandateSchema = z.discriminatedUnion("version", [MandateV1, MandateV2]);

export type DepositMandate = z.infer<typeof DepositMandateSchema>;

/** The cancellation terms a mandate fixed, or null for a version 1 mandate that has none. */
export const mandateCancellation = (m: DepositMandate): CancellationTerms | null => (m.version === 2 ? m.cancellation : null);
export type MandateIssuer = { party: "renter" } | { party: "assistant"; assistant: string | null };

export type MandateInput = {
  rentalId: string;
  item: RentalItem;
  shop: { name: string; city: string };
  renter: { name: string; email: string };
  issuer: MandateIssuer;
  pickup: string;
  returnDate: string;
  days: number;
  feeCents: Cents;
  createdAt: Date;
};

/**
 * The mandate ends 29 days after the pickup date: the life of a PayPal
 * authorization placed at pickup, so nothing is charged on a hold PayPal
 * would no longer honour.
 */
export function mandateExpiry(pickup: string): string {
  return `${addDaysIso(pickup, AUTHORIZATION_VALID_DAYS)}T00:00:00.000Z`;
}

export function buildMandate(input: MandateInput): DepositMandate {
  const { item, renter, issuer } = input;
  return {
    type: "handback.deposit-mandate",
    version: 2,
    rentalId: input.rentalId,
    shop: { name: input.shop.name, city: input.shop.city },
    item: { id: item.id, name: item.name },
    renter: { name: renter.name, email: renter.email },
    issuedTo:
      issuer.party === "assistant"
        ? { party: "assistant", assistant: issuer.assistant, actingFor: `${renter.name} <${renter.email}>` }
        : { party: "renter" },
    period: { pickup: input.pickup, return: input.returnDate, days: input.days },
    currency: "USD",
    feeCents: input.feeCents,
    hold: { maxCents: item.depositCents, starts: "at_pickup" },
    charges: { from: "price_list", onlyAfter: "shown_to_renter", accepted: "charged", questioned: "shop_decides", aboveHold: "saved_paypal" },
    priceList: item.prices.map((p) => ({ id: p.id, label: p.label, kind: p.kind, cents: p.cents })),
    expiresAt: mandateExpiry(input.pickup),
    createdAt: input.createdAt.toISOString(),
    cancellation: cancellationTerms(input.pickup),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The exact text that is stored and hashed: canonical JSON, so key order never changes the hash. */
export function sealMandate(mandate: DepositMandate): { json: string; sha256: string } {
  const json = canonicalJson(mandate);
  return { json, sha256: sha256(json) };
}

/**
 * Reads a stored mandate back. `intact` is false when the text no longer
 * matches its hash or is not exactly a canonical mandate; null when it
 * cannot be read at all.
 */
export function openMandate(json: string, hash: string): { mandate: DepositMandate; intact: boolean } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = DepositMandateSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { mandate: parsed.data, intact: sha256(json) === hash && canonicalJson(parsed.data) === json };
}

export type MandateOnRecord =
  /** Booked before mandates existed: no mandate stored and none recorded. */
  | { kind: "none" }
  | { kind: "trusted"; mandate: DepositMandate }
  | { kind: "untrusted"; problem: string };

/**
 * The rental's mandate, if it can be trusted: the stored text must hash to
 * the value the audit chain recorded when the booking started, be a
 * canonical mandate for this rental, and the chain itself must verify. The
 * same check stands in front of every hold and charge (service.ts) and
 * decides which cancellation terms apply (cancel.ts).
 */
export function mandateOnRecord(rental: Pick<Rental, "id" | "mandateJson" | "mandateSha256">, events: AuditEvent[]): MandateOnRecord {
  const issued = events.find((e) => e.type === "mandate.issued");
  const recorded = typeof issued?.data.sha256 === "string" ? issued.data.sha256 : null;
  if (!recorded && !rental.mandateJson && !rental.mandateSha256) return { kind: "none" };
  const broken = firstBrokenLink(events);
  if (broken !== null) {
    return { kind: "untrusted", problem: `The rental's audit log was changed after the fact (entry ${broken} no longer matches), so the mandate it recorded cannot be trusted.` };
  }
  const opened = rental.mandateJson && rental.mandateSha256 ? openMandate(rental.mandateJson, rental.mandateSha256) : null;
  if (opened?.intact && rental.mandateSha256 === recorded && opened.mandate.rentalId === rental.id) return { kind: "trusted", mandate: opened.mandate };
  return { kind: "untrusted", problem: "The stored mandate is not the one recorded when the booking started, so nothing can be held or charged under it." };
}

/** The mandate in plain sentences, for the renter's page and for assistants to read out. */
export function mandateTerms(m: Pick<DepositMandate, "feeCents" | "hold" | "expiresAt"> & { cancellation?: CancellationTerms }): string[] {
  return [
    `The rental fee of ${formatUsd(m.feeCents)} is paid when you approve the booking in PayPal. Nothing is charged before that.`,
    `When you pick the item up, the shop can hold up to ${formatUsd(m.hold.maxCents)} on the same PayPal account. A hold is not a charge.`,
    "The shop can charge only prices from the price list fixed in the mandate, and only after showing you each charge with the pickup and return photos on your rental page.",
    "You accept or question each charge yourself. A charge you question is decided by a person at the shop after reading your reason.",
    "If the charges come to more than the hold, the difference is charged to the same PayPal account.",
    `Everything held and not charged is released when the shop settles. Nothing can be held or charged under the mandate from ${shortDate(m.expiresAt)}.`,
    ...(m.cancellation ? [termsSummary(m.cancellation, m.feeCents)] : []),
  ];
}

export type MandatedCharge = { priceId: string; label: string; cents: Cents; shownToRenter: boolean };

/**
 * Checks a hold or a set of charges against the mandate before PayPal is
 * called. Returns the reasons it is not allowed; an empty list means go.
 */
export function mandateViolations(m: DepositMandate, act: { at: Date; holdCents?: Cents; charges?: MandatedCharge[] }): string[] {
  const problems: string[] = [];
  if (act.at.getTime() >= Date.parse(m.expiresAt)) problems.push(`The renter's mandate ended on ${shortDate(m.expiresAt)}.`);
  if (act.holdCents !== undefined && act.holdCents > m.hold.maxCents) {
    problems.push(`A hold of ${formatUsd(act.holdCents)} is more than the ${formatUsd(m.hold.maxCents)} the renter allowed.`);
  }
  for (const c of act.charges ?? []) {
    const listed = m.priceList.find((p) => p.id === c.priceId);
    if (!listed || listed.cents !== c.cents) {
      problems.push(`${c.label} at ${formatUsd(c.cents)} is not on the price list the renter agreed to.`);
    } else if (!c.shownToRenter) {
      problems.push(`${c.label} has not been shown to the renter.`);
    }
  }
  return problems;
}
