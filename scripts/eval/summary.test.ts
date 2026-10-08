import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "@/lib/inspection/prompt";
import { encodingComparison, headline, loadSets, looksAgreed, promptComparison, readme, resultsTable, ROOT, twoLookByPrompt, type Finding, type Result, type Run } from "./summary";

/** One look that reported one finding: high-confidence new damage with no price-list entry, unless overridden. */
const look = (f: Partial<Finding> = {}) => ({
  findings: [{ kind: "new_damage", item: "seat tube", confidence: "high", price_item_id: null, ...f }],
});
const unchanged = (id: string, ...outputs: { findings: Finding[] }[]): Result => ({ id, changed: false, caught: [], falseCharges: [], output: outputs[0], outputs });

function run(prompt: number, results: Result[], model = "gemini-test"): Run {
  return {
    file: `${model}-p${prompt}.json`,
    metrics: {
      prompt,
      model,
      thinking: "low",
      passes: 2,
      pairs: results.length,
      realChanges: 0,
      caughtAny: 0,
      caughtCharged: 0,
      pricedRight: 0,
      unchangedPairs: results.length,
      unchangedWithFalseCharge: 0,
      falseChargesOnChangedPairs: 0,
      errors: 0,
      p50ms: 0,
      p95ms: 0,
      inputTokensPerPair: 0,
      outputTokensPerPair: 0,
    },
    results,
  };
}

describe("looksAgreed", () => {
  it("counts two high-confidence findings of one kind with no price-list entry, as consensus would match them", () => {
    expect(looksAgreed(unchanged("bike", look({ item: "seat tube paint" }), look({ item: "seat tube" })))).toBe(true);
  });

  it("needs the same price-list entry on both looks", () => {
    expect(looksAgreed(unchanged("cam", look({ price_item_id: "lens-barrel" }), look({ price_item_id: "top-plate" })))).toBe(false);
    expect(looksAgreed(unchanged("cam", look({ price_item_id: "lens-barrel" }), look({ price_item_id: "lens-barrel" })))).toBe(true);
  });

  it("does not count a low-confidence look, a different kind, wear, or a single look", () => {
    expect(looksAgreed(unchanged("lens", look(), look({ confidence: "low" })))).toBe(false);
    expect(looksAgreed(unchanged("lens", look(), look({ kind: "dirt" })))).toBe(false);
    expect(looksAgreed(unchanged("lens", look({ kind: "wear" }), look({ kind: "wear" })))).toBe(false);
    expect(looksAgreed(unchanged("lens", look()))).toBe(false);
  });
});

describe("promptComparison", () => {
  it("shows a pair that both looks agreed on with one prompt and only one look saw with the other", () => {
    const v1 = run(1, [unchanged("bike", look(), look({ confidence: "low" })), unchanged("cam", look(), look({ kind: "wear" }))]);
    const v2 = run(2, [unchanged("bike", look(), look()), unchanged("cam", look(), look({ kind: "wear" }))]);
    const table = promptComparison([v1, v2]);
    expect(table).toContain("| Unchanged pairs with any finding (charged or noted) | 2/2 | 2/2 |");
    expect(table).toContain("| Unchanged pairs where both looks agreed on a finding | 0/2 | 1/2 |");
    expect(table).toContain("| `bike`: runs with a finding | 1 of 1 | 1 of 1, both looks agreed in 1 |");
    expect(table).toContain("| `cam`: runs with a finding | 1 of 1 | 1 of 1 |");
  });

  it("refuses to compare prompts across different models", () => {
    expect(() => promptComparison([run(1, [], "a"), run(2, [], "b")])).toThrow(/more than one model setup/);
  });
});

describe("runs on the photos as the app stores them", () => {
  const files = run(PROMPT_VERSION, [unchanged("bike", look(), look())]);
  const app: Run = { ...run(PROMPT_VERSION, [unchanged("bike")]), file: "app.json" };
  app.metrics.photos = "app";

  it("get a row of their own and stay out of the prompt comparison and the homepage figures", () => {
    expect(resultsTable([files, app])).toContain(`| gemini-test, thinking low, 2 looks, prompt v${PROMPT_VERSION}, photos as the app stores them | 1 |`);
    expect(twoLookByPrompt([files, app]).get(PROMPT_VERSION)).toEqual([files]);
  });

  it("are compared with the runs on the files of the same prompt", () => {
    expect(encodingComparison([files, app])).toContain("| Unchanged pairs with any finding (charged or noted) | 1/1 | 0/1 |");
    expect(encodingComparison([files])).toMatch(/^No two-look run/);
  });
});

describe("saved eval results", () => {
  it("eval/README.md and eval/headline.json are what the saved runs produce (npm run eval:summary)", async () => {
    const sets = await loadSets();
    expect(await readFile(path.join(ROOT, "eval/README.md"), "utf8")).toBe(readme(sets));
    expect(JSON.parse(await readFile(path.join(ROOT, "eval/headline.json"), "utf8"))).toEqual(headline(sets));
  });
});
