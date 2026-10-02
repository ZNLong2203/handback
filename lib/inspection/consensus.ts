import type { Assessment, AssessedFinding } from "./policy";

const RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Two independent looks at the same photo pair must agree before anything is
 * proposed as a charge. Agreement means the same kind of finding pointing at
 * the same price-list entry. A charge only one look proposed becomes a note,
 * so a single hallucinated dent can never reach the customer's bill; staff
 * still see it and can add it after looking themselves.
 */
export function mergeLooks(a: Assessment, b: Assessment, depositCents: number): Assessment {
  if (!a.usable || !b.usable) {
    return { ...(a.usable ? b : a), findings: [], proposedCents: 0, overDepositCents: 0 };
  }

  const usedB = new Set<string>();
  const merged: AssessedFinding[] = [];

  for (const fa of a.findings) {
    if (fa.decision === "note") continue;
    const fb = b.findings.find(
      (f) => f.decision !== "note" && !usedB.has(f.id) && f.kind === fa.kind && f.price?.id === fa.price?.id,
    );
    if (fb) {
      usedB.add(fb.id);
      const weaker = RANK[fa.confidence] <= RANK[fb.confidence] ? fa : fb;
      merged.push({
        ...fa,
        confidence: weaker.confidence,
        decision: weaker.confidence === "high" ? "propose" : "check",
        reason:
          weaker.confidence === "high"
            ? "Both independent looks saw this clearly in the check-in photo and not in the check-out photo."
            : "Both looks saw this, but at least one was not certain, so a person should confirm it.",
      });
    } else {
      merged.push(asNote(fa));
    }
  }
  for (const fb of b.findings) {
    if (fb.decision !== "note" && !usedB.has(fb.id)) merged.push(asNote(fb));
  }

  // Notes are informational: keep each distinct one once.
  const seen = new Set(merged.map((f) => key(f)));
  for (const f of [...a.findings, ...b.findings]) {
    if (f.decision === "note" && !seen.has(key(f))) {
      seen.add(key(f));
      merged.push(f);
    }
  }

  const findings = merged.map((f, i) => ({ ...f, id: `f${i + 1}` }));
  const proposedCents = findings.filter((f) => f.decision !== "note").reduce((s, f) => s + (f.price?.cents ?? 0), 0);
  return {
    usable: true,
    issue: null,
    findings,
    proposedCents,
    overDepositCents: Math.max(0, proposedCents - depositCents),
    summary: a.summary,
  };
}

function asNote(f: AssessedFinding): AssessedFinding {
  return {
    ...f,
    decision: "note",
    reason: "Only one of two independent looks saw this, so it is not charged. Staff can add it after checking.",
  };
}

function key(f: AssessedFinding): string {
  return `${f.kind}:${f.item.toLowerCase().trim()}`;
}
