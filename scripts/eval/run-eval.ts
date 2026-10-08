/**
 * Runs the condition check on every labeled pair in eval/pairs.json and
 * scores it the way a shop owner and a customer would care about:
 *
 *   - recall: of the real changes, how many did we catch (and price right)?
 *   - false charges: how often would an unchanged item have been charged?
 *
 * Raw model replies are saved under eval/runs/ so the app's demo mode and the
 * tests can replay them without an API key. --set real runs the pairs built
 * on real photographs (eval/real) and saves under eval/real/runs/ instead;
 * --set samples runs the demo-only sample photos (eval/samples), whose
 * recorded replies demo mode also replays.
 *
 * The model normally gets the photo files as they are. --app-encoding first
 * re-encodes each one the way the app stores an uploaded photo
 * (lib/photo-encoding.ts), so the run measures what the app sends; its files
 * get "-app" in their name and its metrics say `photos: "app"`.
 *
 *   npm run eval -- [--set synthetic|real|samples] [--model gemini-3.8-flash] [--thinking low|medium|high] [--passes 2] [--app-encoding] [--only <id-substring>] [--tag r2]
 */
import { ApiError } from "@google/genai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogItem } from "@/lib/catalog";
import { compareCondition, DEFAULT_VISION_MODEL, type Thinking } from "@/lib/inspection/compare";
import { mergeLooks } from "@/lib/inspection/consensus";
import { PROMPT_VERSION } from "@/lib/inspection/prompt";
import { assess, type AssessedFinding } from "@/lib/inspection/policy";
import type { ModelOutput } from "@/lib/inspection/schema";
import { encodePhoto } from "@/lib/photo-encoding";

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
/** Each dataset keeps its pairs, images, runs and reports under its own folder. */
const SETS = { synthetic: "eval", real: "eval/real", samples: "eval/samples" } as const;
const SET_DESCRIPTION = {
  synthetic: "AI-generated photo pairs",
  real: "photo pairs built on real photographs",
  samples: "AI-generated demo sample pairs (not part of the published eval)",
} as const;
const set = (arg("set") ?? "synthetic") as keyof typeof SETS;
if (!(set in SETS)) throw new Error(`--set must be one of: ${Object.keys(SETS).join(", ")}`);
const ROOT = SETS[set];
const model = arg("model") ?? DEFAULT_VISION_MODEL;
const thinking = (arg("thinking") ?? "low") as Thinking;
const only = arg("only");
/** Suffix for repeated runs, e.g. --tag r2, so each run keeps its own files. */
const tag = arg("tag");
/** 2 = two independent looks must agree before a charge is proposed. */
const passes = Number(arg("passes") ?? "1");
/** Send the photos as the app stores them instead of the files as they are. */
const appEncoding = process.argv.includes("--app-encoding");
/**
 * The shop name the prompt carried in every published run (eval/runs, eval/real/runs,
 * eval/samples/runs). The demo shop has since been renamed (SHOP.name in lib/shop.ts);
 * the eval keeps the historical name so a rerun sends the prompt those runs measured.
 */
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
  /** Requests sent again after a network error or a 429/5xx. */
  retries: number;
  caught: { change: string; any: boolean; charged: boolean; priceRight: boolean }[];
  falseCharges: string[];
  notes: number;
  proposedCents: number;
  usable: boolean;
  output?: ModelOutput;
  outputs?: ModelOutput[];
  error?: string;
};

/**
 * The eval measures the model's judgement, not the network: a request that
 * never got an answer (connection dropped, 429, 5xx) is sent again, up to
 * twice, and counted in `retries`. A reply that fails validation is not
 * retried here; that stays an error.
 */
async function withRetry<T>(call: () => Promise<T>, onRetry: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const transient = (err instanceof TypeError && err.message === "fetch failed") || (err instanceof ApiError && (err.status === 429 || err.status >= 500));
      if (!transient || attempt === 2) throw err;
      onRetry();
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function image(rel: string) {
  const bytes = await readFile(path.join(ROOT, rel));
  return { base64: (appEncoding ? (await encodePhoto(bytes)).data : bytes).toString("base64"), mimeType: "image/jpeg" };
}

async function scorePair(pair: Pair): Promise<Scored> {
  const item = catalogItem(pair.item);
  let retries = 0;
  try {
    const input = { before: await image(pair.before), after: await image(pair.after), item, shopName: SHOP, model, thinking };
    const looks = await Promise.all(Array.from({ length: passes }, () => withRetry(() => compareCondition(input), () => retries++)));
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
      retries,
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
      id: pair.id, changed: pair.truth.changed, ms: 0, repaired: false, usage: { inputTokens: 0, outputTokens: 0 }, retries,
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
  const { pairs } = JSON.parse(await readFile(path.join(ROOT, "pairs.json"), "utf8")) as { pairs: Pair[] };
  const todo = only ? pairs.filter((p) => p.id.includes(only)) : pairs;
  console.log(`${model} (thinking ${thinking}, ${passes} look${passes > 1 ? "s" : ""}${appEncoding ? ", photos as the app stores them" : ""}) on ${todo.length} ${set} pairs`);
  const results = await pool(todo, 4, scorePair);

  const changes = results.flatMap((r) => r.caught);
  const unchanged = results.filter((r) => !r.changed);
  const changed = results.filter((r) => r.changed);
  const errors = results.filter((r) => r.error);
  const ms = results.filter((r) => !r.error).map((r) => r.ms);
  const tokens = results.reduce((s, r) => ({ i: s.i + r.usage.inputTokens, o: s.o + r.usage.outputTokens }), { i: 0, o: 0 });

  const metrics = {
    set,
    prompt: PROMPT_VERSION,
    model,
    thinking,
    passes,
    photos: appEncoding ? "app" : "original",
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
    networkRetries: results.reduce((s, r) => s + r.retries, 0),
    p50ms: quantile(ms, 0.5),
    p95ms: quantile(ms, 0.95),
    inputTokensPerPair: Math.round(tokens.i / Math.max(1, results.length)),
    outputTokensPerPair: Math.round(tokens.o / Math.max(1, results.length)),
  };

  const label = `${model}-${thinking}${passes > 1 ? `-x${passes}` : ""}${appEncoding ? "-app" : ""}${tag ? `-${tag}` : ""}`;
  await mkdir(path.join(ROOT, "runs"), { recursive: true });
  await writeFile(path.join(ROOT, "runs", `${label}.json`), `${JSON.stringify({ metrics, results }, null, 2)}\n`);

  const lines = [
    `# Condition-check eval: ${model}, thinking ${thinking}, ${passes} independent look${passes > 1 ? "s that must agree" : ""}`,
    "",
    `${metrics.pairs} labeled ${SET_DESCRIPTION[set]}: ${changed.length} with real changes (${metrics.realChanges} changes in total) and ${unchanged.length} unchanged pairs that only differ in light, pose, dust or glare.`,
    "",
    ...(appEncoding ? ["Each photo was re-encoded the way the app stores an uploaded one (`lib/photo-encoding.ts`) before the model saw it.", ""] : []),
    "| Metric | Result |",
    "|---|---|",
    `| Real changes noticed (any confidence) | ${metrics.caughtAny}/${metrics.realChanges} (${pct(metrics.caughtAny, metrics.realChanges)}) |`,
    `| Real changes proposed as a charge | ${metrics.caughtCharged}/${metrics.realChanges} (${pct(metrics.caughtCharged, metrics.realChanges)}) |`,
    `| ...with the right price-list entry | ${metrics.pricedRight}/${metrics.caughtCharged} |`,
    `| Unchanged pairs that would have been charged | ${metrics.unchangedWithFalseCharge}/${metrics.unchangedPairs} (${pct(metrics.unchangedWithFalseCharge, metrics.unchangedPairs)}) |`,
    `| Extra charges on changed pairs | ${metrics.falseChargesOnChangedPairs} |`,
    `| Errors / replies repaired / requests retried after a network error | ${metrics.errors} / ${metrics.repaired} / ${metrics.networkRetries} |`,
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
  await writeFile(path.join(ROOT, `report-${label}.md`), lines.join("\n"));
  const table = lines.indexOf("| Metric | Result |");
  console.log(lines.slice(table, table + 11).join("\n"));
  console.log(`\nwrote ${ROOT}/report-${label}.md and ${ROOT}/runs/${label}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
