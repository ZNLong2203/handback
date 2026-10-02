import { GoogleGenAI, PartMediaResolutionLevel, ThinkingLevel, createPartFromBase64 } from "@google/genai";
import type { RentalItem } from "@/lib/catalog";
import { buildComparePrompt } from "./prompt";
import { ModelOutputSchema, jsonSchemaFor, type ModelOutput } from "./schema";

export const DEFAULT_VISION_MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 60_000;

export type ImageInput = { base64: string; mimeType: string };
export type Thinking = "low" | "medium" | "high";

export type CompareInput = {
  before: ImageInput;
  after: ImageInput;
  item: RentalItem;
  shopName: string;
  model?: string;
  thinking?: Thinking;
};

export type CompareResult = {
  output: ModelOutput;
  model: string;
  ms: number;
  /** True when the first reply failed validation and the repair turn fixed it. */
  repaired: boolean;
  usage: { inputTokens: number; outputTokens: number };
};

let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const LEVEL: Record<Thinking, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Asks the vision model what changed between the check-out and check-in
 * photos. The reply must match ModelOutputSchema; one repair turn is allowed,
 * after which the call fails rather than guess.
 */
export async function compareCondition(input: CompareInput): Promise<CompareResult> {
  const model = input.model || process.env.AI_MODEL || DEFAULT_VISION_MODEL;
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };

  const contents: { role: "user" | "model"; parts: ReturnType<typeof createPartFromBase64>[] | { text: string }[] }[] = [
    {
      role: "user",
      parts: [
        { text: "Photo A (check-out):" },
        createPartFromBase64(input.before.base64, input.before.mimeType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH),
        { text: "Photo B (check-in):" },
        createPartFromBase64(input.after.base64, input.after.mimeType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH),
        { text: buildComparePrompt(input.item, input.shopName) },
      ] as never,
    },
  ];

  let repaired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ai().models.generateContent({
      model,
      contents: contents as never,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaFor(ModelOutputSchema),
        thinkingConfig: { thinkingLevel: LEVEL[input.thinking ?? "low"] },
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);

    const text = response.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const result = ModelOutputSchema.safeParse(parsed);
    if (result.success) {
      return { output: result.data, model, ms: Date.now() - started, repaired, usage };
    }
    repaired = true;
    contents.push({ role: "model", parts: [{ text }] });
    contents.push({
      role: "user",
      parts: [{ text: `That reply did not match the required JSON schema: ${result.error.message.slice(0, 600)}. Reply again with only valid JSON.` }],
    });
  }
  throw new Error("vision model reply failed validation twice");
}
