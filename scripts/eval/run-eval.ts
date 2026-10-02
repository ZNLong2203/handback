/**
 * Runs the condition check on every labeled pair in eval/pairs.json and
 * scores it the way a shop owner and a customer would care about:
 *
 *   - recall: of the real changes, how many did we catch (and price right)?
 *   - false charges: how often would an unchanged item have been charged?
 *
 * Raw model replies are saved under eval/runs/ so the app's demo mode and the
 * tests can replay them without an API key.
 *
 *   npm run eval -- [--model gemini-3.8-flash] [--thinking low|medium|high] [--only <id-substring>] [--tag r2]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogItem } from "@/lib/catalog";
import { compareCondition, DEFAULT_VISION_MODEL, type Thinking } from "@/lib/inspection/compare";
import { mergeLooks } from "@/lib/inspection/consensus";
import { assess, type AssessedFinding } from "@/lib/inspection/policy";
import type { ModelOutput } from "@/lib/inspection/schema";

type Change = { kind: "missing" | "damage" | "dirt"; item: string; detail: string; match: string[]; price: string };
type Pair = {
  id: string;
  scene: string;
  item: string;
  incidental: string[];
  before: string;
  after: string;
  truth: { changed: boolean; changes: Change[] };
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const model = arg("model") ?? DEFAULT_VISION_MODEL;
const thinking = (arg("thinking") ?? "low") as Thinking;
const only = arg("only");
/** Suffix for repeated runs, e.g. --tag r2, so each run keeps its own files. */
const tag = arg("tag");
/** 2 = two independent looks must agree before a charge is proposed. */
const passes = Number(arg("passes") ?? "1");
const SHOP = "Kestrel Camera Rentals";

const COMPATIBLE: Record<Change["kind"], string[]> = {
  missing: ["missing"],
  damage: ["new_damage"],
  dirt: ["dirt", "new_damage"],
};

const mentions = (f: AssessedFinding, words: string[]) => {
  const text = `${f.item} ${f.description}`.toLowerCase();
  return words.some((w) => text.includes(w.toLowerCase()));
};
const charges = (f: AssessedFinding) => f.decision !== "note";

type Scored = {
  id: string;
  changed: boolean;
  ms: number;
  repaired: boolean;
  usage: { inputTokens: number; outputTokens: number };
  caught: { change: string; any: boolean; charged: boolean; priceRight: boolean }[];
  falseCharges: string[];
  notes: number;
  proposedCents: number;
  usable: boolean;
  output?: ModelOutput;
  outputs?: ModelOutput[];
  error?: string;
};

async function image(rel: string) {
  return { base64: (await readFile(path.join("eval", rel))).toString("base64"), mimeType: "image/jpeg" };
}

async function scorePair(pair: Pair): Promise<Scored> {
  const item = catalogItem(pair.item);
  try {
    const input = { before: await image(pair.before), after: await image(pair.after), item, shopName: SHOP, model, thinking };
    const looks = await Promise.all(Array.from({ length: passes }, () => compareCondition(input)));
    const result = {
      output: looks[0].output,
      outputs: looks.map((l) => l.output),
      ms: Math.max(...looks.map((l) => l.ms)),
      repaired: looks.some((l) => l.repaired),
      usage: looks.reduce((s, l) => ({ inputTokens: s.inputTokens + l.usage.inputTokens, outputTokens: s.outputTokens + l.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 }),
    };
    const assessed = looks.map((l) => assess(l.output, item));
    const a = assessed.length === 2 ? mergeLooks(assessed[0], assessed[1], item.depositCents) : assessed[0];
    const used = new Set<string>();
    const caught = pair.truth.changes.map((c) => {
      const hits = a.findings.filter((f) => COMPATIBLE[c.kind].includes(f.kind) && mentions(f, c.match));
      hits.forEach((h) => used.add(h.id));
      const chargedHit = hits.find(charges);
      return { change: `${c.kind}: ${c.item}`, any: hits.length > 0, charged: Boolean(chargedHit), priceRight: chargedHit?.price?.id === c.price };
    });
    const falseCharges = a.findings
      .filter((f) => charges(f) && !used.has(f.id) && !mentions(f, pair.incidental))
      .map((f) => `${f.kind}: ${f.item} (${f.confidence})`);
    return {
      id: pair.id,
      changed: pair.truth.changed,
      ms: result.ms,
      repaired: result.repaired,
      usage: result.usage,
      caught,
      falseCharges,
      notes: a.findings.filter((f) => f.decision === "note").length,
      proposedCents: a.proposedCents,
      usable: a.usable,
      output: result.output,
      outputs: result.outputs,
    };
  } catch (err) {
    return {
      id: pair.id, changed: pair.truth.changed, ms: 0, repaired: false, usage: { inputTokens: 0, outputTokens: 0 },
      caught: pair.truth.changes.map((c) => ({ change: `${c.kind}: ${c.item}`, any: false, charged: false, priceRight: false })),
      falseCharges: [], notes: 0, proposedCents: 0, usable: false, error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
        process.stdout.write(".");
      }
    }),
  );
  process.stdout.write("\n");
  return out;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

async function main() {
  const { pairs } = JSON.parse(await readFile("eval/pairs.json", "utf8")) as { pairs: Pair[] };
  const todo = only ? pairs.filter((p) => p.id.includes(only)) : pairs;
  console.log(`${model} (thinking ${thinking}, ${passes} look${passes > 1 ? "s" : ""}) on ${todo.length} pairs`);
  const results = await pool(todo, 4, scorePair);

  const changes = results.flatMap((r) => r.caught);
  const unchanged = results.filter((r) => !r.changed);
  const changed = results.filter((r) => r.changed);
  const errors = results.filter((r) => r.error);
  const ms = results.filter((r) => !r.error).map((r) => r.ms);
  const tokens = results.reduce((s, r) => ({ i: s.i + r.usage.inputTokens, o: s.o + r.usage.outputTokens }), { i: 0, o: 0 });

  const metrics = {
    model,
    thinking,
    passes,
    pairs: results.length,
    realChanges: changes.length,
    caughtAny: changes.filter((c) => c.any).length,
    caughtCharged: changes.filter((c) => c.charged).length,
    pricedRight: changes.filter((c) => c.priceRight).length,
    unchangedPairs: unchanged.length,
    unchangedWithFalseCharge: unchanged.filter((r) => r.falseCharges.length > 0).length,
    falseChargesOnChangedPairs: changed.reduce((s, r) => s + r.falseCharges.length, 0),
    errors: errors.length,
    repaired: results.filter((r) => r.repaired).length,
    p50ms: quantile(ms, 0.5),
    p95ms: quantile(ms, 0.95),
    inputTokensPerPair: Math.round(tokens.i / Math.max(1, results.length)),
    outputTokensPerPair: Math.round(tokens.o / Math.max(1, results.length)),
  };

  const label = `${model}-${thinking}${passes > 1 ? `-x${passes}` : ""}${tag ? `-${tag}` : ""}`;
  await mkdir("eval/runs", { recursive: true });
  await writeFile(`eval/runs/${label}.json`, `${JSON.stringify({ metrics, results }, null, 2)}\n`);

  const lines = [
    `# Condition-check eval: ${model}, thinking ${thinking}, ${passes} independent look${passes > 1 ? "s that must agree" : ""}`,
    "",
    `${metrics.pairs} labeled photo pairs: ${changed.length} with real changes (${metrics.realChanges} changes in total) and ${unchanged.length} unchanged pairs that only differ in light, pose, dust or glare.`,
    "",
    "| Metric | Result |",
    "|---|---|",
    `| Real changes noticed (any confidence) | ${metrics.caughtAny}/${metrics.realChanges} (${pct(metrics.caughtAny, metrics.realChanges)}) |`,
    `| Real changes proposed as a charge | ${metrics.caughtCharged}/${metrics.realChanges} (${pct(metrics.caughtCharged, metrics.realChanges)}) |`,
    `| ...with the right price-list entry | ${metrics.pricedRight}/${metrics.caughtCharged} |`,
    `| Unchanged pairs that would have been charged | ${metrics.unchangedWithFalseCharge}/${metrics.unchangedPairs} (${pct(metrics.unchangedWithFalseCharge, metrics.unchangedPairs)}) |`,
    `| Extra charges on changed pairs | ${metrics.falseChargesOnChangedPairs} |`,
    `| Errors / replies repaired | ${metrics.errors} / ${metrics.repaired} |`,
    `| Latency p50 / p95 | ${(metrics.p50ms / 1000).toFixed(1)} s / ${(metrics.p95ms / 1000).toFixed(1)} s |`,
    `| Tokens per pair (in / out) | ${metrics.inputTokensPerPair} / ${metrics.outputTokensPerPair} |`,
    "",
    "## Per pair",
    "",
    "| Pair | Caught | False charges | Notes | Proposed |",
    "|---|---|---|---|---|",
    ...results.map((r) => {
      const caught = r.caught.length ? r.caught.map((c) => `${c.change} ${c.charged ? (c.priceRight ? "✔" : "✔ wrong price") : c.any ? "noted only" : "✘"}`).join("; ") : "—";
      return `| ${r.id} | ${r.error ? `error: ${r.error}` : caught} | ${r.falseCharges.join("; ") || "—"} | ${r.notes} | $${(r.proposedCents / 100).toFixed(2)} |`;
    }),
    "",
  ];
  await writeFile(`eval/report-${label}.md`, lines.join("\n"));
  console.log(lines.slice(4, 15).join("\n"));
  console.log(`\nwrote eval/report-${label}.md and eval/runs/${label}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
