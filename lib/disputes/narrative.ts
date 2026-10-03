import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { DEFAULT_VISION_MODEL } from "@/lib/inspection/compare";
import { jsonSchemaFor } from "@/lib/inspection/schema";
import { formatUsd } from "@/lib/money";
import { factList, type EvidenceFacts, type Fact } from "./facts";

/** What the model must return: short paragraphs, each naming the facts it uses. */
export const NarrativeSchema = z.object({
  paragraphs: z
    .array(
      z.object({
        text: z.string().min(1).max(700).describe("plain English; every number, date and id copied exactly from a cited fact"),
        cites: z.array(z.string()).min(1).max(14).describe("ids of the facts this paragraph uses"),
      }),
    )
    .min(1)
    .max(3),
});
export type NarrativeBody = z.infer<typeof NarrativeSchema>;

export type Narrative = NarrativeBody & {
  source: "gemini" | "template";
  model: string | null;
  /** Why the template was used, when it was. */
  note: string | null;
};

const MAX_WORDS = 170;
const NUMBER = /\d+(?:[.,:]\d+)*/g;
/** Ids and hashes: runs of letters, digits and dashes that contain a digit. */
const ID_LIKE = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;

/**
 * The deterministic gate in front of the model's text: it may only cite
 * facts that exist, and every number and id it writes must appear in a fact
 * it cites. A summary that fails is never printed.
 */
export function narrativeProblems(n: NarrativeBody, facts: Fact[]): string[] {
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const problems: string[] = [];
  const words = n.paragraphs.reduce((sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0);
  if (words > MAX_WORDS) problems.push(`it has ${words} words; the limit is ${MAX_WORDS}`);
  for (const [i, p] of n.paragraphs.entries()) {
    const unknown = p.cites.filter((id) => !byId.has(id));
    if (unknown.length) problems.push(`paragraph ${i + 1} cites ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a fact id`);
    const source = p.cites.map((id) => byId.get(id) ?? "").join(" ");
    const sourceNumbers = source.match(NUMBER) ?? [];
    for (const num of new Set(p.text.match(NUMBER) ?? [])) {
      const found = sourceNumbers.some((s) => s === num || s.startsWith(`${num}.`) || s.startsWith(`${num},`));
      if (!found) problems.push(`paragraph ${i + 1} states "${num}", which is not in the facts it cites`);
    }
    for (const id of new Set(p.text.match(ID_LIKE) ?? [])) {
      if (!source.includes(id)) problems.push(`paragraph ${i + 1} mentions "${id}", which is not in the facts it cites`);
    }
    if (/https?:|www\.|@/i.test(p.text)) problems.push(`paragraph ${i + 1} contains a link or an email address`);
  }
  return problems;
}

export function narrativePrompt(facts: Fact[]): string {
  return `You write the short summary at the end of an evidence pack that a PayPal dispute reviewer will read. The pack is about one in-store equipment rental. These are the facts in the pack, one per line, each with an id in brackets:

${facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}

Rules:
- Use only these facts. Add nothing else, and do not guess at anyone's intent or honesty.
- Copy every number, amount, date, time and id exactly as it appears in a fact, and list that fact's id in "cites" for the paragraph.
- Write 2 or 3 short paragraphs, ${MAX_WORDS - 20} words at most in total, in plain English.
- Follow the order of events: the pickup photo and the customer's confirmation, the return and the comparison, what the customer was shown and how they answered, and what PayPal captured and released.
- Long hashes are already printed elsewhere in the pack; leave them out.
- State the record. Do not argue for an outcome.`;
}

/** The fallback: the same story from fixed sentences, built only from the facts. */
export function templateNarrative(f: EvidenceFacts, note: string | null = null): Narrative {
  const ids = new Set(factList(f).map((x) => x.id));
  const cite = (...wanted: string[]) => wanted.filter((id) => ids.has(id));
  const paragraphs: NarrativeBody["paragraphs"] = [];
  const r = f.rental;

  const p1 = [`${r.customer} rented the ${r.item.toLowerCase()} (rental ${r.id}), picked up ${r.startDate} and due back ${r.endDate}.`];
  if (f.pickup) p1.push(`The shop photographed it at pickup${f.pickup.acknowledgedAt ? ", and the customer confirmed that photo on their own phone before leaving" : ""}.`);
  if (f.money.heldCents !== null) p1.push(`A ${formatUsd(f.money.heldCents)} deposit was held on PayPal, not charged.`);
  paragraphs.push({ text: p1.join(" "), cites: cite("rental", "pickup.photo", "pickup.confirmed", "deposit") });

  if (f.returned && f.inspection) {
    const charged = f.findings.filter((x) => x.charged && x.price);
    const asked = f.findings.filter((x) => x.proposed && x.staff === "keep");
    const p2 = ["When it came back, the return photo was compared with the pickup photo."];
    if (asked.length === 0) p2.push("No change was proposed as a charge.");
    else {
      p2.push(`The shop sent ${asked.length === 1 ? "one priced finding" : `${asked.length} priced findings`} to the customer's phone before charging anything.`);
      const accepted = asked.filter((x) => x.customer === "accept");
      const questioned = asked.filter((x) => x.customer === "contest");
      if (accepted.length) p2.push(`The customer accepted ${accepted.map((x) => `finding ${x.n} (${x.price!.label}, ${formatUsd(x.price!.cents)})`).join(" and ")}.`);
      for (const x of questioned) p2.push(`The customer questioned finding ${x.n}; the counter ${x.resolution === "charge" ? "kept" : "waived"} it after reading the answer.`);
      if (charged.length === 0) p2.push("Nothing was charged in the end.");
    }
    paragraphs.push({ text: p2.join(" "), cites: cite("return.photo", "inspection", "review.sent", ...asked.map((x) => `finding.${x.n}`)) });
  }

  const p3: string[] = [];
  const m = f.money;
  if (m.settledAt) {
    p3.push(
      m.capturedCents
        ? `PayPal captured ${formatUsd(m.capturedCents)} of the deposit and released ${formatUsd(m.releasedCents ?? 0)}.`
        : `PayPal released the whole ${formatUsd(m.releasedCents ?? 0)} deposit.`,
    );
  }
  if (m.refunds?.length) {
    p3.push(`After that, ${formatUsd(m.refunds.reduce((s, x) => s + x.cents, 0))} was refunded to the customer through PayPal.`);
  }
  p3.push(`Every step above is in Handback's hash-chained audit log, which was ${f.audit.intact ? "intact" : "found broken"} when this pack was made.`);
  paragraphs.push({ text: p3.join(" "), cites: cite("settlement", "refunds", "audit") });
  return { paragraphs, source: "template", model: null, note };
}

/** The conversation so far: the prompt, then any rejected reply and the reason it was rejected. */
export type Turn = { role: "user" | "model"; text: string };
export type Generate = (turns: Turn[]) => Promise<string>;

let client: GoogleGenAI | undefined;

/** One Gemini call: JSON that must match NarrativeSchema. */
function geminiGenerate(model: string): Generate {
  return async (turns) => {
    client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const res = await client.models.generateContent({
      model,
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaFor(NarrativeSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        abortSignal: AbortSignal.timeout(30_000),
      },
    });
    return res.text ?? "";
  };
}

/**
 * Writes the pack's summary with Gemini when it is configured, checks it
 * with narrativeProblems, allows one repair turn, and otherwise falls back
 * to the template. The returned narrative says which one it is.
 */
export async function writeNarrative(f: EvidenceFacts, opts: { generate?: Generate; model?: string; enabled?: boolean } = {}): Promise<Narrative> {
  const enabled = opts.enabled ?? (Boolean(process.env.GEMINI_API_KEY) && process.env.DEMO_MODE !== "true");
  if (!enabled && !opts.generate) return templateNarrative(f);
  const model = opts.model ?? (process.env.AI_MODEL || DEFAULT_VISION_MODEL);
  const generate = opts.generate ?? geminiGenerate(model);
  const facts = factList(f);
  const turns: Turn[] = [{ role: "user", text: narrativePrompt(facts) }];
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await generate(turns);
    } catch (err) {
      return templateNarrative(f, `Gemini did not answer (${err instanceof Error ? err.message.slice(0, 120) : "error"}).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const result = NarrativeSchema.safeParse(parsed);
    const problems = result.success ? narrativeProblems(result.data, facts) : [`the reply did not match the schema: ${result.error.message.slice(0, 300)}`];
    if (result.success && problems.length === 0) return { ...result.data, source: "gemini", model, note: null };
    last = problems[0];
    turns.push({ role: "model", text }, { role: "user", text: `That reply was rejected because ${problems.slice(0, 5).join("; ")}. Write it again following every rule, as JSON only.` });
  }
  return templateNarrative(f, `Gemini's summary was rejected by the fact check: ${last}.`);
}
