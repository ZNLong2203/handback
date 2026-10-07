import type { Content, FunctionDeclaration, GenerateContentConfig, GenerateContentResponse, Part } from "@google/genai";
import { z } from "zod";

/**
 * The mapping between AG Studio's provider-neutral turn (AgLlmRequest, the
 * shape its direct LLM runner hands an adapter) and Gemini's generateContent.
 * Pure, so it is tested without a network. The route in
 * app/api/insights/llm/route.ts runs it on the server, where the key lives.
 *
 * Studio's item shapes are re-declared here as zod schemas: the route checks
 * what the browser sent before anything reaches Gemini.
 */

// ─── What the browser may send ───────────────────────────────

const Text = z.object({ type: z.literal("text"), text: z.string().max(40_000) });

const InputMessage = z.object({
  id: z.string().max(200).optional(),
  kind: z.literal("input").optional(),
  type: z.literal("message"),
  role: z.enum(["user", "system"]),
  content: z.array(z.union([Text, z.looseObject({ type: z.string() })])).max(20),
  status: z.string().optional(),
});
const OutputMessage = z.object({
  id: z.string().max(200).optional(),
  kind: z.literal("output").optional(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.union([Text, z.object({ type: z.literal("refusal"), refusal: z.string().max(20_000) }), z.looseObject({ type: z.string() })])).max(20),
  status: z.string().optional(),
});
const ToolCall = z.object({
  id: z.string().max(4_000).optional(),
  kind: z.literal("output").optional(),
  type: z.literal("function_call"),
  callId: z.string().max(12_000),
  name: z.string().max(128),
  arguments: z.string().max(100_000),
  status: z.string().optional(),
});
const ToolResult = z.object({
  id: z.string().max(200).optional(),
  kind: z.literal("input").optional(),
  type: z.literal("function_call_output"),
  callId: z.string().max(12_000),
  output: z.string().max(200_000),
  status: z.string().optional(),
});
const Reasoning = z.looseObject({ type: z.literal("reasoning") });

const Item = z.union([InputMessage, OutputMessage, ToolCall, ToolResult, Reasoning]);

const ToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
  description: z.string().max(8_000),
  parameters: z.record(z.string(), z.unknown()),
  kind: z.enum(["client", "server", "provided"]).optional(),
});

export const LlmRequestSchema = z.object({
  input: z.array(Item).max(400),
  instructions: z.string().max(120_000).optional(),
  tools: z.array(ToolSchema).max(64).optional(),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().max(128) })]).optional(),
  responseFormat: z
    .union([z.object({ type: z.literal("text") }), z.object({ type: z.literal("json"), name: z.string().max(128), description: z.string().max(2_000).optional(), schema: z.record(z.string(), z.unknown()) })])
    .optional(),
  model: z.object({ id: z.string().max(80), effort: z.string().max(40).optional() }).optional(),
});

export type LlmRequest = z.infer<typeof LlmRequestSchema>;

// ─── What goes back ──────────────────────────────────────────

export type OutputItem =
  | { id: string; kind: "output"; type: "message"; role: "assistant"; status: "completed"; content: { type: "text"; text: string; annotations: never[] }[] }
  | { id: string; kind: "output"; type: "function_call"; callId: string; name: string; arguments: string; status: "completed" };

export type LlmResponse = {
  id: string;
  createdAt: number;
  status: "completed" | "incomplete" | "failed";
  output: OutputItem[];
  incompleteDetails?: { reason?: "max_output_tokens" | "content_filter" };
  error?: { code: string; message: string };
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; reasoningTokens?: number };
  model?: string;
};

// ─── Schemas ─────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// Studio's shapes mark "may be undefined" as a `{ not: {} }` branch of an anyOf.
const isUndefinedSentinel = (v: unknown) => isObj(v) && Object.keys(v).length === 1 && isObj(v.not) && Object.keys(v.not).length === 0;

const DROP = new Set(["$schema", "not", "patternProperties", "unevaluatedProperties", "dependentRequired", "dependentSchemas", "if", "then", "else", "contains", "propertyNames", "examples", "default", "readOnly", "writeOnly", "deprecated", "$comment"]);

/**
 * Studio emits JSON Schema 2020-12. Gemini's parametersJsonSchema takes most
 * of it ($defs, $ref, anyOf, enum, ranges) but not every keyword: this drops
 * the ones it does not take, turns `const` into a one-value enum and removes
 * the undefined sentinel.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!isObj(schema)) return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP.has(k)) continue;
    if (k === "const") {
      out.enum = [v];
      if (out.type === undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out.type = typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
      continue;
    }
    if ((k === "anyOf" || k === "oneOf") && Array.isArray(v)) {
      const branches = v.filter((b) => !isUndefinedSentinel(b)).map(toGeminiSchema);
      if (branches.length === 1 && isObj(branches[0])) Object.assign(out, branches[0]);
      else if (branches.length > 0) out.anyOf = branches;
      continue;
    }
    if (k === "properties" && isObj(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)]));
      continue;
    }
    if (k === "$defs" && isObj(v)) {
      out.$defs = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)]));
      continue;
    }
    if (k === "additionalProperties" && isObj(v)) {
      out.additionalProperties = toGeminiSchema(v);
      continue;
    }
    out[k] = isObj(v) || Array.isArray(v) ? toGeminiSchema(v) : v;
  }
  return out;
}

/** A tool whose parameters are not an object at the root is wrapped as { input: ... } for Gemini, and unwrapped on the way back. */
export function rootIsObject(schema: Json): boolean {
  return schema.type === "object" || isObj(schema.properties);
}

export function functionDeclarations(tools: LlmRequest["tools"]): { declarations: FunctionDeclaration[]; wrapped: Set<string> } {
  const wrapped = new Set<string>();
  const declarations = (tools ?? [])
    .filter((t) => t.kind !== "provided")
    .map((t) => {
      const params = toGeminiSchema(t.parameters) as Json;
      if (rootIsObject(params)) return { name: t.name, description: t.description, parametersJsonSchema: params };
      wrapped.add(t.name);
      const { $defs, ...inner } = params;
      return {
        name: t.name,
        description: t.description,
        parametersJsonSchema: { type: "object", properties: { input: inner }, required: ["input"], ...($defs ? { $defs } : {}) },
      };
    });
  return { declarations, wrapped };
}

// ─── Thought signatures ──────────────────────────────────────

/**
 * Gemini 3 refuses a replayed function call without the thought signature it
 * came with (checked live: "Function call is missing a thought_signature").
 * Studio keeps the conversation in the browser and sends it back each turn,
 * so the signature rides inside the call id Studio pairs results by:
 * `<Gemini's call id>~<signature>`. Nothing is kept on the server. A call
 * with no signature (another provider's history, an older turn) gets the
 * placeholder Gemini documents for injected calls.
 */
export const SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";
const SEP = "~";

export const packCallId = (id: string, signature: string | undefined) => (signature ? `${id}${SEP}${signature}` : id);
export function unpackCallId(callId: string): { id: string; signature: string | null } {
  const i = callId.indexOf(SEP);
  return i < 0 ? { id: callId, signature: null } : { id: callId.slice(0, i), signature: callId.slice(i + 1) };
}

// ─── Request ─────────────────────────────────────────────────

function parseArgs(text: string): Json {
  try {
    const v = JSON.parse(text || "{}");
    return isObj(v) ? v : { value: v };
  } catch {
    return {};
  }
}

function outputValue(text: string): Json {
  try {
    const v = JSON.parse(text);
    return isObj(v) ? v : { output: v };
  } catch {
    return { output: text };
  }
}

export function toGeminiRequest(req: LlmRequest): { contents: Content[]; config: GenerateContentConfig; wrapped: Set<string> } {
  const { declarations, wrapped } = functionDeclarations(req.tools);
  const system: string[] = req.instructions ? [req.instructions] : [];
  const contents: Content[] = [];
  const names = new Map<string, string>();
  const push = (role: "user" | "model", part: Part) => {
    const last = contents.at(-1);
    if (last && last.role === role) last.parts!.push(part);
    else contents.push({ role, parts: [part] });
  };
  let firstCallOfTurn = true;
  for (const item of req.input) {
    if (item.type === "reasoning") continue;
    if (item.type === "message" && item.role === "system") {
      system.push(textOf(item.content));
      continue;
    }
    if (item.type === "message" && item.role === "user") {
      firstCallOfTurn = true;
      const text = textOf(item.content);
      if (text) push("user", { text });
      continue;
    }
    if (item.type === "message" && item.role === "assistant") {
      const text = textOf(item.content);
      if (text) push("model", { text });
      continue;
    }
    if (item.type === "function_call") {
      const { id, signature } = unpackCallId(item.callId);
      names.set(item.callId, item.name);
      let args = parseArgs(item.arguments);
      if (wrapped.has(item.name)) args = { input: args };
      // Only the first call of a parallel set carries Gemini's signature.
      const sig = signature ?? (firstCallOfTurn ? SIGNATURE_PLACEHOLDER : undefined);
      push("model", { functionCall: { id, name: item.name, args }, ...(sig ? { thoughtSignature: sig } : {}) });
      firstCallOfTurn = false;
      continue;
    }
    if (item.type === "function_call_output") {
      firstCallOfTurn = true;
      const { id } = unpackCallId(item.callId);
      push("user", { functionResponse: { id, name: names.get(item.callId) ?? "tool", response: outputValue(item.output) } });
    }
  }

  const config: GenerateContentConfig = {};
  const json = req.responseFormat?.type === "json" ? req.responseFormat : null;
  if (declarations.length > 0 && req.toolChoice !== "none") {
    config.tools = [{ functionDeclarations: declarations }];
    const choice = req.toolChoice;
    config.toolConfig = {
      functionCallingConfig:
        choice === "required"
          ? { mode: "ANY" as never }
          : choice && typeof choice === "object"
            ? { mode: "ANY" as never, allowedFunctionNames: [choice.name] }
            : { mode: "AUTO" as never },
    };
    if (json) system.push(`Answer as JSON matching this schema (${json.name}): ${JSON.stringify(json.schema)}`);
  } else if (json) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = toGeminiSchema(json.schema);
  }
  if (system.length) config.systemInstruction = system.join("\n\n");
  return { contents, config, wrapped };
}

function textOf(content: { type: string; text?: unknown }[]): string {
  return content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ─── Response ────────────────────────────────────────────────

export function fromGeminiResponse(res: Pick<GenerateContentResponse, "candidates" | "usageMetadata" | "modelVersion" | "responseId">, wrapped: Set<string>, ids: () => string): LlmResponse {
  const candidate = res.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const output: OutputItem[] = [];
  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (text.trim()) output.push({ id: `msg_${ids()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
  for (const p of parts) {
    if (!p.functionCall?.name) continue;
    let args = (p.functionCall.args ?? {}) as Json;
    if (wrapped.has(p.functionCall.name) && isObj(args.input)) args = args.input;
    const callId = packCallId(p.functionCall.id || `call_${ids()}`, p.thoughtSignature);
    output.push({ id: `fc_${ids()}`, kind: "output", type: "function_call", callId, name: p.functionCall.name, arguments: JSON.stringify(args), status: "completed" });
  }
  const reason = candidate?.finishReason;
  const blocked = reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "BLOCKLIST" || reason === "RECITATION" || res.candidates === undefined;
  const usage = res.usageMetadata
    ? {
        inputTokens: res.usageMetadata.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: res.usageMetadata.totalTokenCount,
        reasoningTokens: res.usageMetadata.thoughtsTokenCount,
      }
    : undefined;
  return {
    id: res.responseId ?? `resp_${ids()}`,
    createdAt: Date.now(),
    status: reason === "MAX_TOKENS" || (blocked && output.length === 0) ? "incomplete" : "completed",
    ...(reason === "MAX_TOKENS" ? { incompleteDetails: { reason: "max_output_tokens" as const } } : blocked && output.length === 0 ? { incompleteDetails: { reason: "content_filter" as const } } : {}),
    output,
    usage,
    model: res.modelVersion,
  };
}
