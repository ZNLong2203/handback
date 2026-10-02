/**
 * Turns the saved runs of both eval sets (eval/runs/ and eval/real/runs/)
 * into eval/README.md and the homepage figures in eval/headline.json.
 *
 * Every table, the pair-by-pair list, the numbers inside the text and the
 * homepage figures are computed here from the saved runs. The sentences
 * around those numbers are written by hand in `readme` below: reread them
 * after adding or rerunning a run. summary.test.ts fails while the committed
 * files differ from what the saved runs produce.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_VERSION } from "@/lib/inspection/prompt";
import { REAL_EDITS } from "./real-photos";

export type Metrics = {
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
export type Finding = { kind: string; item: string; confidence: string; price_item_id?: string | null };
export type Result = {
  id: string;
  changed: boolean;
  caught: { change: string; any: boolean; charged: boolean; priceRight: boolean }[];
  falseCharges: string[];
  error?: string;
  /** The first look. */
  output?: { findings: Finding[] };
  /** Every look, in two-look runs. */
  outputs?: { findings: Finding[] }[];
};
export type Run = { file: string; metrics: Metrics; results: Result[] };
export type Pair = { id: string; scene: string; truth: { changed: boolean; changes: unknown[] } };
export type EvalSet = { pairs: Pair[]; runs: Run[] };
export type Sets = { synthetic: EvalSet; real: EvalSet };

/** Runs written before the real-photo set existed have no `set` and belong to the synthetic one. */
export const SETS = [
  { id: "synthetic", dir: "eval", title: "Synthetic set" },
  { id: "real", dir: "eval/real", title: "Real-photo set" },
] as const;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function loadSet(dir: string): Promise<EvalSet> {
  const pairs = (JSON.parse(await readFile(path.join(ROOT, dir, "pairs.json"), "utf8")) as { pairs: Pair[] }).pairs;
  const runsDir = path.join(ROOT, dir, "runs");
  const files = existsSync(runsDir) ? (await readdir(runsDir)).filter((f) => f.endsWith(".json")).sort() : [];
  const runs: Run[] = await Promise.all(files.map(async (f) => ({ file: f, ...JSON.parse(await readFile(path.join(runsDir, f), "utf8")) })));
  return { pairs, runs };
}

export async function loadSets(): Promise<Sets> {
  const [synthetic, real] = await Promise.all(SETS.map((s) => loadSet(s.dir)));
  return { synthetic, real };
}

const passes = (m: Metrics) => m.passes ?? 1;
const promptOf = (m: Metrics) => m.prompt ?? 1;
const setup = (m: Metrics) => `${m.model}, thinking ${m.thinking}, ${passes(m)} look${passes(m) > 1 ? "s" : ""}, prompt v${promptOf(m)}`;
const looks = (r: Result) => r.outputs ?? (r.output ? [r.output] : []);

/** Kinds the policy can charge for. Wear and marks already there at check-out are always notes. */
const CHARGEABLE = new Set(["new_damage", "missing", "dirt"]);

/**
 * What any look reported on a pair where nothing changed, other than marks
 * already there at check-out. Uncharged findings still reach staff and the
 * customer as notes, so they count against the model even when the price
 * list or the second look kept them off the bill.
 */
export const falseFindings = (r: Result) => (r.changed ? [] : looks(r).flatMap((o) => o.findings.filter((f) => f.kind !== "pre_existing")));

/**
 * Whether both looks at an unchanged pair reported the same chargeable kind
 * of finding at high confidence and pointed it at the same price-list entry,
 * or both at none. That is the match lib/inspection/consensus.ts needs before
 * it proposes a charge, so only a missing price-list entry keeps such a
 * finding off the bill.
 */
export function looksAgreed(r: Result) {
  const [a, b] = r.outputs ?? [];
  if (r.changed || !a || !b) return false;
  const strong = (o: { findings: Finding[] }) => o.findings.filter((f) => CHARGEABLE.has(f.kind) && f.confidence === "high");
  return strong(a).some((fa) => strong(b).some((fb) => fb.kind === fa.kind && (fb.price_item_id ?? null) === (fa.price_item_id ?? null)));
}

/** Whether any look pointed a chargeable finding on an unchanged pair at a price-list entry. */
export const lookPriced = (r: Result) => !r.changed && looks(r).some((o) => o.findings.some((f) => CHARGEABLE.has(f.kind) && f.price_item_id));

const sum = (rs: Run[], k: keyof Metrics) => rs.reduce((s, r) => s + Number(r.metrics[k]), 0);
const count = (rs: Run[], test: (r: Result) => boolean) => rs.reduce((s, run) => s + run.results.filter(test).length, 0);
const noted = (r: Result) => falseFindings(r).length > 0;
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

/** Runs grouped by setup, in a stable order: one look before two, older prompts first. */
function bySetup(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const r of runs) groups.set(setup(r.metrics), [...(groups.get(setup(r.metrics)) ?? []), r]);
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Two-look runs by prompt version, oldest first. Comparing prompts only makes sense on one model setup. */
export function twoLookByPrompt(runs: Run[]) {
  const twoLook = runs.filter((r) => passes(r.metrics) === 2);
  const models = new Set(twoLook.map((r) => `${r.metrics.model}, thinking ${r.metrics.thinking}`));
  if (models.size > 1) throw new Error(`two-look runs use more than one model setup (${[...models].join("; ")}): compare prompts per model`);
  const versions = [...new Set(twoLook.map((r) => promptOf(r.metrics)))].sort((a, b) => a - b);
  return new Map(versions.map((v) => [v, twoLook.filter((r) => promptOf(r.metrics) === v)]));
}

/** In how many of `runs` one pair drew a finding although nothing changed, and in how many both looks agreed on it. */
export function pairRuns(runs: Run[], id: string) {
  const results = runs.map((run) => run.results.find((r) => r.id === id)).filter((r) => r !== undefined);
  return { runs: runs.length, withFinding: results.filter(noted).length, agreed: results.filter(looksAgreed).length };
}

export function resultsTable(runs: Run[]) {
  if (runs.length === 0) return "No saved runs yet.";
  const rows = [...bySetup(runs).entries()].map(([key, rs]) => {
    const changes = sum(rs, "realChanges");
    const charged = sum(rs, "caughtCharged");
    const unchanged = sum(rs, "unchangedPairs");
    const falsePairs = sum(rs, "unchangedWithFalseCharge");
    const notedPairs = count(rs, noted);
    return `| ${key} | ${rs.length} | ${charged}/${changes} (${pct(charged, changes)}) | ${sum(rs, "pricedRight")}/${charged} | ${falsePairs}/${unchanged} (${pct(falsePairs, unchanged)}) | ${notedPairs}/${unchanged} (${pct(notedPairs, unchanged)}) | ${sum(rs, "falseChargesOnChangedPairs")} | ${sum(rs, "errors")} | ${(Math.max(...rs.map((r) => r.metrics.p95ms)) / 1000).toFixed(1)} s |`;
  });
  return [
    "| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * Two-look runs side by side, one column per prompt version: the totals, then
 * every unchanged pair that drew a finding with any of the prompts.
 */
export function promptComparison(runs: Run[]) {
  const byPrompt = twoLookByPrompt(runs);
  if (byPrompt.size < 2) return "Only one prompt version has two-look runs.";
  const columns = [...byPrompt.values()];
  const row = (label: string, cell: (rs: Run[]) => string) => `| ${label} | ${columns.map(cell).join(" | ")} |`;
  const share = (test: (r: Result) => boolean) => (rs: Run[]) => `${count(rs, test)}/${sum(rs, "unchangedPairs")}`;
  const ids = [...new Set(columns.flat().flatMap((run) => run.results.filter(noted).map((r) => r.id)))].sort();
  return [
    `| Two looks | ${[...byPrompt.keys()].map((v) => `Prompt v${v}`).join(" | ")} |`,
    `|---|${columns.map(() => "---|").join("")}`,
    row("Runs", (rs) => String(rs.length)),
    row("Real changes proposed as a charge", (rs) => `${sum(rs, "caughtCharged")}/${sum(rs, "realChanges")}`),
    row("Unchanged pairs charged", (rs) => `${sum(rs, "unchangedWithFalseCharge")}/${sum(rs, "unchangedPairs")}`),
    row("Unchanged pairs with any finding (charged or noted)", share(noted)),
    row("Unchanged pairs where both looks agreed on a finding", share(looksAgreed)),
    row("Unchanged pairs where a look named a price-list entry", share(lookPriced)),
    ...ids.map((id) =>
      row(`\`${id}\`: runs with a finding`, (rs) => {
        const p = pairRuns(rs, id);
        return `${p.withFinding} of ${p.runs}${p.agreed ? `, both looks agreed in ${p.agreed}` : ""}`;
      }),
    ),
  ].join("\n");
}

/** Every pair that went wrong in at least one run, with what went wrong and in how many runs, per setup. */
export function misses(runs: Run[]) {
  const lines: string[] = [];
  for (const [key, rs] of bySetup(runs)) {
    const byPair = new Map<string, { counts: Map<string, number>; noted: Set<string> }>();
    for (const run of rs) {
      for (const r of run.results) {
        const findings = r.falseCharges.length ? [] : falseFindings(r);
        const problems = [
          ...(r.error ? [`error: ${r.error}`] : []),
          ...r.caught.filter((c) => !c.charged).map((c) => `${c.change} ${c.any ? "noted but not charged" : "missed"}`),
          ...r.caught.filter((c) => c.charged && !c.priceRight).map((c) => `${c.change} charged at the wrong price`),
          ...r.falseCharges.map((f) => `false charge: ${f}`),
          ...(findings.length
            ? [looksAgreed(r) ? "nothing changed, but both looks agreed on a finding (not charged)" : "nothing changed, but a finding was noted (not charged)"]
            : []),
        ];
        if (!problems.length) continue;
        const entry = byPair.get(r.id) ?? { counts: new Map<string, number>(), noted: new Set<string>() };
        for (const p of new Set(problems)) entry.counts.set(p, (entry.counts.get(p) ?? 0) + 1);
        for (const f of findings) entry.noted.add(`${f.kind} "${f.item}"`);
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

/** How much of each real-photo check-in frame the pasted box of image-model output covers, largest first. */
export function pastedShare() {
  return REAL_EDITS.map((e) => ({ id: e.id, share: ((e.region[2] - e.region[0]) * (e.region[3] - e.region[1])) / 1e6 })).sort(
    (a, b) => b.share - a.share || a.id.localeCompare(b.id),
  );
}

function counts({ pairs }: EvalSet) {
  const changed = pairs.filter((p) => p.truth.changed);
  return {
    pairs: pairs.length,
    scenes: new Set(pairs.map((p) => p.scene)).size,
    changed: changed.length,
    changes: changed.reduce((s, p) => s + p.truth.changes.length, 0),
    unchanged: pairs.length - changed.length,
  };
}

/** The figures the homepage shows: two looks with the prompt the app sends now, per set. */
export function headline(sets: Sets) {
  return {
    about: "Written by npm run eval:summary from the saved runs; do not edit by hand.",
    prompt: PROMPT_VERSION,
    sets: SETS.map(({ id }) => {
      const runs = twoLookByPrompt(sets[id].runs).get(PROMPT_VERSION) ?? [];
      if (runs.length === 0) throw new Error(`the ${id} set has no two-look run of prompt v${PROMPT_VERSION}: run the eval before summarizing`);
      return {
        id,
        pairs: sets[id].pairs.length,
        runs: runs.length,
        changesCharged: sum(runs, "caughtCharged"),
        changes: sum(runs, "realChanges"),
        unchangedCharged: sum(runs, "unchangedWithFalseCharge"),
        unchanged: sum(runs, "unchangedPairs"),
      };
    }),
  };
}

export function readme(sets: Sets) {
  const synthetic = counts(sets.synthetic);
  const real = counts(sets.real);
  const pasted = pastedShare();
  const overAThird = pasted.filter((p) => p.share > 1 / 3);
  const percent = (share: number) => `${Math.round(share * 100)}%`;

  const oneLookReal = sets.real.runs.filter((r) => passes(r.metrics) === 1);
  const hoodCharged = oneLookReal.filter((run) => run.results.some((r) => r.id === "sigma-150-600__missing-hood" && r.caught.every((c) => c.charged))).length;
  const realByPrompt = twoLookByPrompt(sets.real.runs);
  const syntheticByPrompt = twoLookByPrompt(sets.synthetic.runs);
  const [v1, v2] = [realByPrompt.get(1) ?? [], realByPrompt.get(2) ?? []];
  const [nikon1, nikon2] = [v1, v2].map((rs) => pairRuns(rs, "nikon-z6ii__same-pose"));
  const [ebike1, ebike2] = [v1, v2].map((rs) => pairRuns(rs, "ebike-rear__same-dust-glare"));
  const [sony1, sony2] = [v1, v2].map((rs) => pairRuns(rs, "sony-100-400__same-dust-glare"));
  const share = (rs: Run[], test: (r: Result) => boolean) => `${count(rs, test)}/${sum(rs, "unchangedPairs")}`;
  const [syn1, syn2] = [syntheticByPrompt.get(1) ?? [], syntheticByPrompt.get(2) ?? []];

  return `# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

There are two labeled sets of check-out / check-in photo pairs. Both are scored the same way; they differ in where the photos come from.

## Data

### Synthetic set (\`pairs.json\`, \`images/\`)

${synthetic.pairs} pairs of eight of the demo shop's nine rental items (\`lib/catalog.ts\`): ${synthetic.changed} changed pairs with ${synthetic.changes} changes in total, and ${synthetic.unchanged} unchanged pairs.

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change (a warm tint that also drains colour, which matters little on these mostly grey scenes), a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (\`scripts/eval/make-pairs.ts\`). That makes ground truth exact, but clean generated scenes are easier than real photos. The app's demo mode replays one saved run of this set.

### Real-photo set (\`real/pairs.json\`, \`real/images/\`)

${real.pairs} pairs built on ${real.scenes} real photographs from Wikimedia Commons under CC0, CC BY and CC BY-SA licenses: ${real.changed} changed pairs with ${real.changes} changes in total, and ${real.unchanged} unchanged pairs. Sources, authors and licenses are in [\`real/CREDITS.md\`](real/CREDITS.md); these images are not covered by the repository's MIT license. The photos and the changes asked of the image model are listed in \`scripts/eval/real-photos.ts\`.

- **Base photos.** Real photographs of gear like the demo shop rents: three camera bodies (one laid out as a kit), two telephoto lenses, a drone with its controller, an action camera with its housing, a portable speaker, a projector, and two bicycle rears. They have real lighting, reflections, texture, printed text and cluttered backgrounds (a wooden table, a railing with grass, paving), which the synthetic set lacks. Each pair is mapped to the catalog item whose kit list and price list fit it.
- **Changed pairs.** The same Gemini image model edited each photo (a scratch, a dent, a crack, a torn grille, mud, or a removed accessory). The model redraws the whole photo and often shifts or zooms it a little, so its edit is first lined up with the original (\`scripts/eval/composite.ts\`), and only a box around the requested change is pasted back with a soft edge. Everything outside that box is the original photograph. Code then made the light warmer and dimmer or turned the photo by 3°. Every pair was reviewed by eye. Five prompts the model ignored were rewritten and run again, and labels say what the edit actually shows where it differs from what was asked (a chipped, not shortened, tripod foot; a cracked, not bent, mudguard).
- **How much is drawn, and where it shows.** The pasted box (before its soft edge) covers ${percent(pasted[pasted.length - 1].share)} to ${percent(pasted[0].share)} of the frame. In ${overAThird.length} pairs it covers more than a third (${overAThird.map((p) => `\`${p.id}\` ${percent(p.share)}`).join(", ")}), so that much of the check-in photo is the image model's drawing, not the photograph. The box's colour is matched to the original with one average shift per colour channel, measured in a ring just outside it. Where the image model redrew a plain background in a slightly different tone, that leaves a faint step along part of the box edge: about 10 to 15 levels (of 255) on plain background in \`sony-action-cam__missing-housing\`, \`dji-mini4__missing-controller\` and \`sony-a7r-kit__missing-battery\`, less in the others. The step shows where the edit is, so the model may find these changes more easily than in a real check-in photo, and the share of changes caught on this set may be optimistic. Unchanged pairs have no pasted box. A better colour match would change these photos and void every saved run of the set, including the prompt v1 runs the comparison below rests on, so the photos were left as they are.
- **Unchanged pairs.** A warmer, dimmer light that keeps the photo's colours, a 3° turn with the smallest crop that hides the corners, or dust specks and a glare spot, all in code.

What this set does not show: the damage itself is still drawn by an image model, sometimes over a large part of the frame and with a visible box edge, and the second photo is the first one shifted in code, not a second photo taken minutes later with a phone. Most base photos are well-lit product shots rather than counter photos taken by staff. A set of real before / after photos of real damage is still missing.

### Demo samples (\`samples/\`), not scored here

The city bike, the ninth rental item, has AI-generated sample photos for the demo in their own folder, so adding them changed none of the numbers below. Each return photo was built the way the real-photo set is: every change is its own image-model edit, lined up with the pickup photo and pasted back only inside its box (\`scripts/eval/sample-photos.ts\`). Demo mode replays one two-look run of them (\`samples/runs/\`, report in \`samples/\`).

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (\`lib/inspection/policy.ts\`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged, so they never count as false charges.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (\`lib/inspection/consensus.ts\`).

"Unchanged pairs with any finding" counts unchanged pairs where any look reported a change other than a mark already there at check-out, charged or not. An uncharged finding is not a false charge, but it still reaches staff and the customer as a note.

"Both looks agreed" means both looks reported the same kind of new damage, missing part or dirt at high confidence and pointed it at the same price-list entry, or both at none. That is the match consensus needs before it proposes a charge, so on an unchanged pair only a missing price-list entry keeps such a finding off the bill.

Requests that fail on the network (or get a 429 or 5xx) are sent again, up to twice; a reply that fails validation counts as an error. The first two-look run of the real set lost two requests to the network before this retry existed and was run again.

## Results

### Synthetic set

${resultsTable(sets.synthetic.runs)}

### Real-photo set

${resultsTable(sets.real.runs)}

### What the real photos showed

- **Charges.** In every run on the real photos, with one look or two and with either prompt, no unchanged pair was charged and every charged change got the right price-list entry.
- **What two looks cost.** The one real change missed is the removed Sigma lens hood (\`sigma-150-600__missing-hood\`). Without it the lens ends in a front barrel almost as wide and just as black, and in every two-look run at least one look did not see the hood was gone, so consensus kept it off the bill. With one look it was charged in ${hoodCharged} of ${oneLookReal.length} runs. Two looks trade a little recall for safety, which is the trade the app makes.
- **Findings on unchanged items.** With prompt v1, two unchanged pairs drew high-confidence findings in almost every run. None was charged, because the second look disagreed or no price-list entry fit, but uncharged findings still reach staff and the customer as notes:
  - After a 3° turn of the Nikon photo the model said the "Z 6II" badge was now upside down. It is not: apart from the 3° turn and the crop, the two photos are the same pixels. In one two-look run one look also priced "inverted" lens and mode-dial markings at $120 + $60; the other look disagreed.
  - A glare spot over a textured or painted part was read as damage: the ribbed zoom ring of the Sony lens "worn smooth", and once the e-bike's seat tube "scuffed". The spot also lightens the background around it, which a person would take as a sign of light, not wear.

### Prompt v2: what changed and what did not

The prompt already told the model to ignore camera angle and glare. Prompt v2 (\`lib/inspection/prompt.ts\`) names the two cases above: printed text never turns around, and texture that only looks smooth where the light is brightest is glare. Both sets were run again with two looks; the Runs row says how often.

Real-photo set:

${promptComparison(sets.real.runs)}

Synthetic set:

${promptComparison(sets.synthetic.runs)}

- **The text sentence worked.** The turned Nikon photo drew a finding in ${nikon1.withFinding} of ${nikon1.runs} prompt v1 runs and in ${nikon2.withFinding} of ${nikon2.runs} prompt v2 runs.
- **The glare sentence did not, and on the e-bike it made things worse.** The e-bike's glare pair drew a finding in ${ebike1.withFinding} of ${ebike1.runs} prompt v1 runs${ebike1.agreed ? `, with both looks agreeing in ${ebike1.agreed}` : ", and the two looks never agreed on it"}. With prompt v2 it drew one in ${ebike2.withFinding} of ${ebike2.runs} runs, and in ${ebike2.agreed} of them both looks reported new damage to the seat tube at high confidence: the agreement the app needs before it proposes a charge. It stayed off the bill only because the e-bike's price list (\`lib/catalog.ts\`) has no entry for the frame, so the app would show it to staff as a note they can price by hand. The Sony lens's glare pair drew a finding in ${sony1.withFinding} of ${sony1.runs} runs with prompt v1 and ${sony2.withFinding} of ${sony2.runs} with prompt v2.
- **The totals on the real set hardly moved.** Prompt v2 removed the Nikon findings and added e-bike ones. Unchanged pairs with any finding: ${share(v1, noted)} with prompt v1 and ${share(v2, noted)} with prompt v2. Where both looks agreed: ${share(v1, looksAgreed)} and ${share(v2, looksAgreed)}, the Nikon then and the e-bike now. Where a look named a price-list entry: ${share(v1, lookPriced)} and ${share(v2, lookPriced)}, the Nikon markings above.
- **Synthetic set.** Unchanged pairs with any finding went from ${share(syn1, noted)} to ${share(syn2, noted)}: a grille dent one look priced on an unchanged speaker, which the other look did not see.

Prompt v2 is what the app now sends, because it removes the text mistake; the glare mistake is still open. The demo mode still replays a prompt v1 run of the synthetic set.

**Proposed fix for glare (not built yet).** Glare is a photo problem more than a wording problem, so the fix belongs before the model: \`lib/photos.ts\` already rejects blurry, dark and washed-out photos in code. A local check could compare the check-in photo with the check-out photo and flag a region where brightness rises while contrast and colour drop across both the item and its background, and ask staff to retake the photo away from the light before the condition check runs.

### What went wrong, pair by pair

Synthetic set:

${misses(sets.synthetic.runs)}

Real-photo set:

${misses(sets.real.runs)}

Per-pair results and the model's raw replies are in \`runs/\` and \`real/runs/\`. Reproduce with \`npm run eval:pairs -- --set real\`, then \`npm run eval -- --set real --passes 2 --tag r1\`, then \`npm run eval:summary\` (leave out \`--set real\` for the synthetic set).
`;
}
