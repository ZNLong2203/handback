import { describe, expect, it } from "vitest";
import { sampleFacts } from "./test-fixtures";
import { factList } from "./facts";
import { narrativeProblems, writeNarrative, type Turn } from "./narrative";

const facts = factList(sampleFacts);
const good = {
  paragraphs: [
    { text: "Maya Chen picked up the camera kit on 2026-10-02 and confirmed the pickup photo on her phone at 2026-10-02 14:02 UTC.", cites: ["rental", "pickup.confirmed"] },
    { text: "She accepted the $35.00 lens hood charge, and PayPal released $265.00 of the $300.00 deposit.", cites: ["finding.1", "settlement", "deposit"] },
  ],
};

describe("narrativeProblems", () => {
  it("accepts text whose numbers all come from the facts it cites", () => {
    expect(narrativeProblems(good, facts)).toEqual([]);
  });

  it("rejects invented amounts, ids, unknown facts and links", () => {
    const bad = {
      paragraphs: [
        { text: "The customer was charged $40.00 on capture 9ZZ99999XX9999999Z.", cites: ["finding.1", "nope"] },
        { text: "See https://example.com for details.", cites: ["audit"] },
      ],
    };
    const problems = narrativeProblems(bad, facts).join(" | ");
    expect(problems).toContain('"40.00"');
    expect(problems).toContain('"9ZZ99999XX9999999Z"');
    expect(problems).toContain("nope, which is not a fact id");
    expect(problems).toContain("link or an email");
  });

  it("requires the number to be in a cited fact, not just somewhere in the pack", () => {
    const miscited = { paragraphs: [{ text: "PayPal released $265.00.", cites: ["rental"] }] };
    expect(narrativeProblems(miscited, facts)[0]).toContain('"265.00"');
  });
});

describe("writeNarrative", () => {
  it("uses Gemini's text when it passes the check", async () => {
    const n = await writeNarrative(sampleFacts, { generate: async () => JSON.stringify(good), model: "gemini-test" });
    expect(n).toMatchObject({ source: "gemini", model: "gemini-test", note: null, paragraphs: good.paragraphs });
  });

  it("gives one repair turn with the rejected reply and the reason", async () => {
    const seen: Turn[][] = [];
    const wrong = { paragraphs: [{ text: "PayPal kept $45.00.", cites: ["settlement"] }] };
    const n = await writeNarrative(sampleFacts, {
      generate: async (turns) => {
        seen.push(structuredClone(turns));
        return JSON.stringify(seen.length === 1 ? wrong : good);
      },
    });
    expect(n.source).toBe("gemini");
    expect(seen[1].map((t) => t.role)).toEqual(["user", "model", "user"]);
    expect(seen[1][2].text).toContain('"45.00"');
  });

  it("falls back to the template, saying why, when the reply fails twice or the call fails", async () => {
    const twice = await writeNarrative(sampleFacts, { generate: async () => "not json" });
    expect(twice.source).toBe("template");
    expect(twice.note).toContain("rejected by the fact check");
    const down = await writeNarrative(sampleFacts, { generate: async () => Promise.reject(new Error("503 UNAVAILABLE")) });
    expect(down).toMatchObject({ source: "template" });
    expect(down.note).toContain("503 UNAVAILABLE");
  });

  it("uses the template without calling anything when AI is off", async () => {
    const n = await writeNarrative(sampleFacts, { enabled: false });
    expect(n).toMatchObject({ source: "template", note: null });
  });
});
