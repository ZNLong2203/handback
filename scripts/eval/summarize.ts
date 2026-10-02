/**
 * Rolls every run in eval/runs/ into eval/README.md, so the numbers quoted in
 * the project README always come from saved runs.   npm run eval:summary
 */
import { readdir, readFile, writeFile } from "node:fs/promises";

type Metrics = {
  model: string;
  thinking: string;
  passes?: number;
  pairs: number;
  realChanges: number;
  caughtAny: number;
  caughtCharged: number;
  pricedRight: number;
  unchangedPairs: number;
  unchangedWithFalseCharge: number;
  falseChargesOnChangedPairs: number;
  errors: number;
  p50ms: number;
  p95ms: number;
  inputTokensPerPair: number;
  outputTokensPerPair: number;
};

const files = (await readdir("eval/runs")).filter((f) => f.endsWith(".json")).sort();
const runs = await Promise.all(files.map(async (f) => ({ file: f, metrics: JSON.parse(await readFile(`eval/runs/${f}`, "utf8")).metrics as Metrics })));

const groups = new Map<string, typeof runs>();
for (const r of runs) {
  const key = `${r.metrics.model}, thinking ${r.metrics.thinking}, ${r.metrics.passes ?? 1} look${(r.metrics.passes ?? 1) > 1 ? "s" : ""}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}

const sum = (rs: typeof runs, k: keyof Metrics) => rs.reduce((s, r) => s + Number(r.metrics[k]), 0);
const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

const rows = [...groups.entries()].map(([key, rs]) => {
  const changes = sum(rs, "realChanges");
  const charged = sum(rs, "caughtCharged");
  const unchanged = sum(rs, "unchangedPairs");
  const falsePairs = sum(rs, "unchangedWithFalseCharge");
  return `| ${key} | ${rs.length} | ${charged}/${changes} (${pct(charged, changes)}) | ${sum(rs, "pricedRight")}/${charged} | ${falsePairs}/${unchanged} (${pct(falsePairs, unchanged)}) | ${sum(rs, "falseChargesOnChangedPairs")} | ${(Math.max(...rs.map((r) => r.metrics.p95ms)) / 1000).toFixed(1)} s |`;
});

const doc = `# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

## Data

\`pairs.json\` lists ${runs[0]?.metrics.pairs ?? "?"} labeled check-out / check-in photo pairs of the demo shop's eight rental items (\`lib/catalog.ts\`):

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change, a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (\`scripts/eval/make-pairs.ts\`). That makes ground truth exact but is easier than real counter photos; a real-photo set is the next step.

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (\`lib/inspection/policy.ts\`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged and are not counted against the model.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (\`lib/inspection/consensus.ts\`).

## Results

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Extra charges on changed pairs | Worst p95 latency |
|---|---|---|---|---|---|---|
${rows.join("\n")}

Per-pair results and the model's raw replies are in \`runs/\`. Reproduce with \`npm run eval:pairs\`, then \`npm run eval -- --passes 2 --tag r1\`, then \`npm run eval:summary\`.
`;

await writeFile("eval/README.md", doc);
console.log(rows.join("\n"));
