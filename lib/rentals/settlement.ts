import type { Cents } from "@/lib/money";
import type { ReviewedFinding } from "./types";

/** Is this finding part of the charge right now? */
export function isCharged(f: ReviewedFinding): boolean {
  if (f.decision === "note" || f.staff === "waive" || !f.price) return false;
  if (f.customer === "contest") return f.resolution === "charge";
  return true;
}

export type SettlementLine = { findingId: string; label: string; cents: Cents };

export type SettlementPlan = {
  lines: SettlementLine[];
  totalCents: Cents;
  /** Taken from the deposit hold with one final capture. */
  captureCents: Cents;
  /** Given back: the rest of the hold, released by PayPal. */
  releasedCents: Cents;
  /** Above the deposit, charged to the saved PayPal wallet. */
  extraCents: Cents;
  /** Above the deposit with no saved wallet: the shop has to invoice it. */
  uncollectedCents: Cents;
};

/**
 * Pure arithmetic from reviewed findings to money movements. Amounts come
 * only from price-list entries attached to findings people kept.
 */
export function planSettlement(findings: ReviewedFinding[], authorizedCents: Cents, hasSavedWallet: boolean): SettlementPlan {
  const lines = findings
    .filter(isCharged)
    .map((f) => ({ findingId: f.id, label: f.price!.label, cents: f.price!.cents }));
  const totalCents = lines.reduce((s, l) => s + l.cents, 0);
  const captureCents = Math.min(totalCents, authorizedCents);
  const over = totalCents - captureCents;
  return {
    lines,
    totalCents,
    captureCents,
    releasedCents: authorizedCents - captureCents,
    extraCents: hasSavedWallet ? over : 0,
    uncollectedCents: hasSavedWallet ? 0 : over,
  };
}

/** Findings the customer still has to answer before the counter can settle. */
export function awaitingCustomer(findings: ReviewedFinding[]): ReviewedFinding[] {
  return findings.filter((f) => f.decision !== "note" && f.staff === "keep" && f.price && f.customer === null);
}

/** Contested findings the counter has not ruled on yet. */
export function awaitingResolution(findings: ReviewedFinding[]): ReviewedFinding[] {
  return findings.filter((f) => f.staff === "keep" && f.customer === "contest" && f.resolution === null);
}
