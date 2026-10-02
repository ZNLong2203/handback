/**
 * Rolls every saved run of both eval sets (eval/runs/ and eval/real/runs/)
 * into eval/README.md, so the numbers quoted elsewhere always come from saved
 * runs.   npm run eval:summary
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Metrics = {
  set?: string;
  /** lib/inspection/prompt.ts PROMPT_VERSION; runs from before it existed used version 1. */
  prompt?: number;
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
type Finding = { kind: string; item: string; confidence: string };
type Result = {
  id: string;
  changed: boolean;
  caught: { change: string; any: boolean; charged: boolean; priceRight: boolean }[];
  falseCharges: string[];
  error?: string;
  output?: { findings: Finding[] };
  outputs?: { findings: Finding[] }[];
};
type Run = { file: string; metrics: Metrics; results: Result[] };
type PairsFile = { pairs: { id: string; scene: string; truth: { changed: boolean; changes: unknown[] } }[] };

/** Runs written before the real-photo set existed have no `set` and belong to the synthetic one. */
const SETS = [
  { id: "synthetic", dir: "eval", title: "Synthetic set" },
  { id: "real", dir: "eval/real", title: "Real-photo set" },
] as const;

async function loadSet(dir: string) {
  const pairs = (JSON.parse(await readFile(path.join(dir, "pairs.json"), "utf8")) as PairsFile).pairs;
  const runsDir = path.join(dir, "runs");
  const files = existsSync(runsDir) ? (await readdir(runsDir)).filter((f) => f.endsWith(".json")).sort() : [];
  const runs: Run[] = await Promise.all(files.map(async (f) => ({ file: f, ...JSON.parse(await readFile(path.join(runsDir, f), "utf8")) })));
  return { pairs, runs };
}

const setup = (m: Metrics) => `${m.model}, thinking ${m.thinking}, ${m.passes ?? 1} look${(m.passes ?? 1) > 1 ? "s" : ""}, prompt v${m.prompt ?? 1}`;

/**
 * What any look reported on a pair where nothing changed, other than marks
 * already there at check-out. Uncharged findings still reach staff and the
 * customer as notes, so they count against the model even when the price
 * list or the second look kept them off the bill.
 */
const falseFindings = (r: Result) =>
  r.changed ? [] : (r.outputs ?? (r.output ? [r.output] : [])).flatMap((o) => o.findings.filter((f) => f.kind !== "pre_existing"));
const sum = (rs: Run[], k: keyof Metrics) => rs.reduce((s, r) => s + Number(r.metrics[k]), 0);
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

function bySetup(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const r of runs) groups.set(setup(r.metrics), [...(groups.get(setup(r.metrics)) ?? []), r]);
  return groups;
}

function resultsTable(runs: Run[]) {
  if (runs.length === 0) return "No saved runs yet.";
  const rows = [...bySetup(runs).entries()].map(([key, rs]) => {
    const changes = sum(rs, "realChanges");
    const charged = sum(rs, "caughtCharged");
    const unchanged = sum(rs, "unchangedPairs");
    const falsePairs = sum(rs, "unchangedWithFalseCharge");
    const noted = rs.reduce((s, r) => s + r.results.filter((x) => falseFindings(x).length > 0).length, 0);
    return `| ${key} | ${rs.length} | ${charged}/${changes} (${pct(charged, changes)}) | ${sum(rs, "pricedRight")}/${charged} | ${falsePairs}/${unchanged} (${pct(falsePairs, unchanged)}) | ${noted}/${unchanged} (${pct(noted, unchanged)}) | ${sum(rs, "falseChargesOnChangedPairs")} | ${sum(rs, "errors")} | ${(Math.max(...rs.map((r) => r.metrics.p95ms)) / 1000).toFixed(1)} s |`;
  });
  return [
    "| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Every pair that went wrong in at least one run, with what went wrong and in how many runs, per setup. */
function misses(runs: Run[]) {
  const lines: string[] = [];
  for (const [key, rs] of bySetup(runs)) {
    const byPair = new Map<string, { counts: Map<string, number>; noted: Set<string> }>();
    for (const run of rs) {
      for (const r of run.results) {
        const noted = r.falseCharges.length ? [] : falseFindings(r);
        const problems = [
          ...(r.error ? [`error: ${r.error}`] : []),
          ...r.caught.filter((c) => !c.charged).map((c) => `${c.change} ${c.any ? "noted but not charged" : "missed"}`),
          ...r.caught.filter((c) => c.charged && !c.priceRight).map((c) => `${c.change} charged at the wrong price`),
          ...r.falseCharges.map((f) => `false charge: ${f}`),
          ...(noted.length ? ["nothing changed, but a finding was noted (not charged)"] : []),
        ];
        if (!problems.length) continue;
        const entry = byPair.get(r.id) ?? { counts: new Map<string, number>(), noted: new Set<string>() };
        for (const p of new Set(problems)) entry.counts.set(p, (entry.counts.get(p) ?? 0) + 1);
        for (const f of noted) entry.noted.add(`${f.kind} "${f.item}"`);
        byPair.set(r.id, entry);
      }
    }
    if (byPair.size === 0) {
      lines.push(`- **${key}:** no pair went wrong in any of the ${rs.length} runs.`);
      continue;
    }
    lines.push(`- **${key}** (${rs.length} runs):`);
    for (const [id, { counts, noted }] of [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const text = [...counts.entries()].map(([p, n]) => `${p} in ${n} of ${rs.length} runs`).join("; ");
      lines.push(`  - \`${id}\`: ${text}${noted.size ? `: ${[...noted].join(", ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

const loaded = Object.fromEntries(await Promise.all(SETS.map(async (s) => [s.id, await loadSet(s.dir)] as const)));
const counts = (id: (typeof SETS)[number]["id"]) => {
  const { pairs } = loaded[id];
  const changed = pairs.filter((p) => p.truth.changed);
  return {
    pairs: pairs.length,
    scenes: new Set(pairs.map((p) => p.scene)).size,
    changed: changed.length,
    changes: changed.reduce((s, p) => s + p.truth.changes.length, 0),
    unchanged: pairs.length - changed.length,
  };
};
const synthetic = counts("synthetic");
const real = counts("real");

const doc = `# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

There are two labeled sets of check-out / check-in photo pairs. Both are scored the same way; they differ in where the photos come from.

## Data

### Synthetic set (\`pairs.json\`, \`images/\`)

${synthetic.pairs} pairs of the demo shop's eight rental items (\`lib/catalog.ts\`): ${synthetic.changed} changed pairs with ${synthetic.changes} changes in total, and ${synthetic.unchanged} unchanged pairs.

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change, a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (\`scripts/eval/make-pairs.ts\`). That makes ground truth exact, but clean generated scenes are easier than real photos. The app's demo mode replays one saved run of this set.

### Real-photo set (\`real/pairs.json\`, \`real/images/\`)

${real.pairs} pairs built on ${real.scenes} real photographs from Wikimedia Commons under CC0, CC BY and CC BY-SA licenses: ${real.changed} changed pairs with ${real.changes} changes in total, and ${real.unchanged} unchanged pairs. Sources, authors and licenses are in [\`real/CREDITS.md\`](real/CREDITS.md); the photos and the changes asked of the image model are listed in \`scripts/eval/real-photos.ts\`.

- **Base photos.** Real photographs of gear like the demo shop rents: three camera bodies (one laid out as a kit), two telephoto lenses, a drone with its controller, an action camera with its housing, a portable speaker, a projector, and two bicycle rears. They have real lighting, reflections, texture, printed text and cluttered backgrounds (a wooden table, a railing with grass, paving), which the synthetic set lacks. Each pair is mapped to the catalog item whose kit list and price list fit it.
- **Changed pairs.** The same Gemini image model edited each photo (a scratch, a dent, a crack, a torn grille, mud, or a removed accessory), but only a box around the requested change was pasted back onto the original photo with a soft edge. Everything outside that box is the original photograph. Code then shifted the light or turned the photo by 3°. Every pair was reviewed by eye; labels say what the edit actually shows.
- **Unchanged pairs.** As in the synthetic set: a lighting change, a 3° turn with the smallest crop that hides the corners, or dust and glare, all in code.

What this set does not show: the damage itself is still drawn by an image model, and the second photo is the first one shifted in code, not a second photo taken minutes later with a phone. Most base photos are well-lit product shots rather than counter photos taken by staff. A set of real before / after photos of real damage is still missing.

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (\`lib/inspection/policy.ts\`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged and are not counted against the model.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (\`lib/inspection/consensus.ts\`).

## Results

### Synthetic set

${resultsTable(loaded.synthetic.runs)}

### Real-photo set

${resultsTable(loaded.real.runs)}

### What went wrong, pair by pair

Synthetic set:

${misses(loaded.synthetic.runs)}

Real-photo set:

${misses(loaded.real.runs)}

Per-pair results and the model's raw replies are in \`runs/\` and \`real/runs/\`. Reproduce with \`npm run eval:pairs -- --set real\`, then \`npm run eval -- --set real --passes 2 --tag r1\`, then \`npm run eval:summary\` (leave out \`--set real\` for the synthetic set).
`;

await writeFile("eval/README.md", doc);
for (const s of SETS) console.log(`${s.title}\n${resultsTable(loaded[s.id].runs)}\n`);
