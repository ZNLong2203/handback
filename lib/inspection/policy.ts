import type { PriceItem, RentalItem } from "@/lib/catalog";
import type { Cents } from "@/lib/money";
import { normaliseBox, type Box, type FindingKind, type ModelOutput } from "./schema";

export type Decision =
  /** Proposed charge; staff still approve and the customer can contest. */
  | "propose"
  /** Proposed, but the model was not certain: staff must look before approving. */
  | "check"
  /** Shown to everyone, never charged. */
  | "note";

export type AssessedFinding = {
  id: string;
  kind: FindingKind;
  item: string;
  description: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  boxBefore: Box | null;
  boxAfter: Box | null;
  price: PriceItem | null;
  decision: Decision;
  /** Why the policy decided this, in plain words. */
  reason: string;
};

export type Assessment = {
  usable: boolean;
  issue: string | null;
  findings: AssessedFinding[];
  /** Sum of findings with decision "propose" or "check". */
  proposedCents: Cents;
  /** Part of the proposal the deposit cannot cover. */
  overDepositCents: Cents;
  summary: string;
};

const PRICE_KIND: Partial<Record<FindingKind, PriceItem["kind"]>> = {
  missing: "missing",
  new_damage: "damage",
  dirt: "dirt",
};

/**
 * The deterministic gate between the model and money. The model's reply is
 * only an opinion: amounts come from the shop's price list, a charge needs a
 * chargeable kind, a matching price-list entry and enough confidence, and
 * anything uncertain becomes a note rather than a charge.
 */
export function assess(output: ModelOutput, item: RentalItem): Assessment {
  if (!output.photos_usable || !output.same_item) {
    return {
      usable: false,
      issue: output.photo_issue ?? (output.same_item ? "The photos are not clear enough to compare." : "The two photos do not show the same item."),
      findings: [],
      proposedCents: 0,
      overDepositCents: 0,
      summary: output.summary,
    };
  }

  const charged = new Set<string>();
  const findings = output.findings.map((f, i): AssessedFinding => {
    const base = {
      id: `f${i + 1}`,
      kind: f.kind,
      item: f.item,
      description: f.description,
      evidence: f.evidence,
      confidence: f.confidence,
      boxBefore: normaliseBox(f.box_before),
      boxAfter: normaliseBox(f.box_after),
    };
    const wantedKind = PRICE_KIND[f.kind];
    if (!wantedKind) {
      const reason = f.kind === "pre_existing" ? "Already there at check-out, so not charged." : "Normal wear, so not charged.";
      return { ...base, price: null, decision: "note", reason };
    }
    const price = item.prices.find((p) => p.id === f.price_item_id && p.kind === wantedKind) ?? null;
    if (!price) {
      return { ...base, price: null, decision: "note", reason: "No matching entry in the price list; staff can price it by hand." };
    }
    if (f.confidence === "low") {
      return { ...base, price, decision: "note", reason: "Not certain enough to charge. Unclear findings are never charged." };
    }
    if (charged.has(price.id) && !price.id.startsWith("missing-")) {
      return { ...base, price, decision: "note", reason: "Same repair already proposed; charged once." };
    }
    charged.add(price.id);
    return {
      ...base,
      price,
      decision: f.confidence === "high" ? "propose" : "check",
      reason: f.confidence === "high" ? "Clearly visible in the check-in photo and not in the check-out photo." : "Likely, but a person should confirm it.",
    };
  });

  const proposedCents = findings
    .filter((f) => f.decision !== "note" && f.price)
    .reduce((sum, f) => sum + (f.price?.cents ?? 0), 0);

  return {
    usable: true,
    issue: null,
    findings,
    proposedCents,
    overDepositCents: Math.max(0, proposedCents - item.depositCents),
    summary: output.summary,
  };
}
