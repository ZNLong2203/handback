// The evidence pack is deterministic: same facts, narrative and photos give
// the same bytes, and the photos inside the PDF are the stored originals.
import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { factList } from "./facts";
import { factsSha, paypalNotes, renderEvidencePdf, sha256Hex } from "./evidence";
import { narrativeProblems, templateNarrative } from "./narrative";
import { pickup, returned, sampleFacts } from "./test-fixtures";

const photos = { pickup, returned };

describe("renderEvidencePdf", () => {
  it("gives byte-identical output for the same inputs", async () => {
    const narrative = templateNarrative(sampleFacts);
    const a = await renderEvidencePdf(sampleFacts, narrative, photos);
    const b = await renderEvidencePdf(structuredClone(sampleFacts), structuredClone(narrative), { pickup: pickup.slice(), returned: returned.slice() });
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    if (process.env.EVIDENCE_PDF_OUT) writeFileSync(process.env.EVIDENCE_PDF_OUT, a);
  });

  it("changes when any fact changes", async () => {
    const narrative = templateNarrative(sampleFacts);
    const base = sha256Hex(await renderEvidencePdf(sampleFacts, narrative, photos));
    const other = { ...sampleFacts, findings: [{ ...sampleFacts.findings[0], customer: "contest" as const, customerNote: "It was in the bag." }, sampleFacts.findings[1]] };
    expect(sha256Hex(await renderEvidencePdf(other, narrative, photos))).not.toBe(base);
    expect(factsSha(other)).not.toBe(factsSha(sampleFacts));
  });

  it("embeds both photos byte for byte, so their printed hashes can be checked from the PDF", async () => {
    const pdf = Buffer.from(await renderEvidencePdf(sampleFacts, templateNarrative(sampleFacts), photos));
    expect(pdf.indexOf(Buffer.from(pickup))).toBeGreaterThan(0);
    expect(pdf.indexOf(Buffer.from(returned))).toBeGreaterThan(0);
  });

  it("is one page with metadata fixed to the record's time", async () => {
    const doc = await PDFDocument.load(await renderEvidencePdf(sampleFacts, templateNarrative(sampleFacts), photos), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getCreationDate()?.toISOString()).toBe("2026-10-05T16:42:10.000Z");
    expect(doc.getTitle()).toBe("Evidence pack: rental R-7KQ2MX, PayPal dispute PP-R-CHU-10190215");
  });

  it("stays on one page with ten findings, text it cannot encode, and no photos", async () => {
    const many = {
      ...sampleFacts,
      findings: Array.from({ length: 10 }, (_, i) => ({
        ...sampleFacts.findings[0],
        n: i + 1,
        description: `Finding ${i + 1}: a long description that wraps over several lines to push the table down the page, with “quotes” → arrows, emoji 🙂 and naïve accents.`,
        customer: "contest" as const,
        customerNote: "I don't agree — it was like that ✓",
        resolution: "charge" as const,
      })),
    };
    const doc = await PDFDocument.load(await renderEvidencePdf(many, templateNarrative(many), { pickup: null, returned: null }));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("template narrative and PayPal notes", () => {
  it("passes the same fact check Gemini's text must pass", () => {
    const n = templateNarrative(sampleFacts);
    expect(n.source).toBe("template");
    expect(narrativeProblems(n, factList(sampleFacts))).toEqual([]);
  });

  it("fits PayPal's 2000-character notes limit and names the pack's hash", () => {
    const notes = paypalNotes(sampleFacts, templateNarrative(sampleFacts), "a".repeat(64));
    expect(notes.length).toBeLessThanOrEqual(2000);
    expect(notes).toContain("R-7KQ2MX-evidence.pdf");
    expect(notes).toContain("a".repeat(64));
    const long = { ...templateNarrative(sampleFacts), paragraphs: [{ text: "word ".repeat(600), cites: ["rental"] }] };
    expect(paypalNotes(sampleFacts, long, "b".repeat(64)).length).toBeLessThanOrEqual(2000);
  });
});
