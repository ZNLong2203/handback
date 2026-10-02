import "server-only";
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { z } from "zod";
import { DEFAULT_VISION_MODEL } from "@/lib/inspection/compare";
import { jsonSchemaFor } from "@/lib/inspection/schema";

// The schedule's two small Gemini jobs: write a short customer message, and
// turn a typed command into one tool call. Both run on the server with a
// prompt the server builds; the browser only ever sends the typed words.

const TIMEOUT_MS = 20_000;

let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export const scheduleModel = () => process.env.AI_MODEL || DEFAULT_VISION_MODEL;

/** JSON that must match `schema`; returns null when the reply does not. */
export async function generateJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T | null> {
  const response = await ai().models.generateContent({
    model: scheduleModel(),
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchemaFor(schema),
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });
  try {
    const parsed = schema.safeParse(JSON.parse(response.text ?? ""));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ToolSpec = { name: string; description: string; schema: z.ZodType };
export type ToolCall = { name: string; args: unknown };

/** Forces exactly one call to one of `tools`. Returns the first call, or null if the model made none. */
export async function callOneTool(prompt: string, tools: ToolSpec[]): Promise<ToolCall | null> {
  const response = await ai().models.generateContent({
    model: scheduleModel(),
    contents: prompt,
    config: {
      tools: [
        {
          functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: jsonSchemaFor(t.schema) })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: tools.map((t) => t.name) } },
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });
  const call = response.functionCalls?.[0];
  return call?.name ? { name: call.name, args: call.args ?? {} } : null;
}
