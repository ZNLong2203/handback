import { describe, expect, it } from "vitest";
import { fromGeminiResponse, functionDeclarations, LlmRequestSchema, packCallId, SIGNATURE_PLACEHOLDER, toGeminiRequest, toGeminiSchema, unpackCallId, type LlmRequest } from "./gemini";

const user = (text: string) => ({ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text }] });
let n = 0;
const ids = () => `id${++n}`;

describe("toGeminiSchema", () => {
  it("keeps $defs, $ref and anyOf, turns const into a one-value enum and drops the undefined sentinel", () => {
    const out = toGeminiSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kind: { const: "agg" },
        limit: { anyOf: [{ type: "number" }, { not: {} }], description: "rows" },
        query: { anyOf: [{ $ref: "#/$defs/a" }, { type: "string" }] },
      },
      $defs: { a: { type: "object", properties: { n: { const: 3 } }, examples: [{ n: 3 }] } },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        kind: { enum: ["agg"], type: "string" },
        limit: { type: "number", description: "rows" },
        query: { anyOf: [{ $ref: "#/$defs/a" }, { type: "string" }] },
      },
      $defs: { a: { type: "object", properties: { n: { enum: [3], type: "integer" } } } },
    });
  });

  it("wraps a tool whose parameters are not an object at the root, and remembers it", () => {
    const { declarations, wrapped } = functionDeclarations([
      { name: "run_query", description: "q", parameters: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }], $defs: { x: { type: "string" } } } },
      { name: "plain", description: "p", parameters: { type: "object", properties: {} } },
      { name: "web_search", description: "w", parameters: { type: "object" }, kind: "provided" },
    ]);
    expect(wrapped).toEqual(new Set(["run_query"]));
    expect(declarations.map((d) => d.name)).toEqual(["run_query", "plain"]);
    expect(declarations[0].parametersJsonSchema).toMatchObject({ type: "object", required: ["input"], $defs: { x: { type: "string" } } });
  });
});

describe("toGeminiRequest", () => {
  it("maps instructions, history, calls and results, pairing each result with its call's name and signature", () => {
    const callId = packCallId("call_1", "c2lnbmF0dXJl");
    const req: LlmRequest = LlmRequestSchema.parse({
      instructions: "You are the deposit desk.",
      input: [
        { type: "message", role: "system", content: [{ type: "text", text: "Extra system note." }] },
        user("Which holds need attention?"),
        { type: "message", role: "assistant", content: [{ type: "text", text: "Checking.", annotations: [] }] },
        { type: "function_call", callId, name: "holds_needing_attention", arguments: "{}" },
        { type: "function_call", callId: "call_2", name: "explain_rental", arguments: '{"rental_id":"R-AAAAAA"}' },
        { type: "function_call_output", callId, output: '{"holds":[]}', status: "completed" },
        { type: "function_call_output", callId: "call_2", output: "not json", status: "completed" },
        { type: "reasoning", summary: [] },
      ],
      tools: [{ name: "holds_needing_attention", description: "d", parameters: { type: "object", properties: {} } }],
      toolChoice: { name: "holds_needing_attention" },
      responseFormat: { type: "text" },
    });
    const { contents, config } = toGeminiRequest(req);
    // A system message in the conversation is left out: the system prompt is the turn's instructions only.
    expect(config.systemInstruction).toBe("You are the deposit desk.");
    expect(config.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["holds_needing_attention"] } });
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts).toEqual([
      { text: "Checking." },
      { functionCall: { id: "call_1", name: "holds_needing_attention", args: {} }, thoughtSignature: "c2lnbmF0dXJl" },
      // The second call of a parallel set carries no signature of its own.
      { functionCall: { id: "call_2", name: "explain_rental", args: { rental_id: "R-AAAAAA" } } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { id: "call_1", name: "holds_needing_attention", response: { holds: [] } } },
      { functionResponse: { id: "call_2", name: "explain_rental", response: { output: "not json" } } },
    ]);
  });

  it("gives a replayed call without a signature Gemini's documented placeholder", () => {
    const req = LlmRequestSchema.parse({
      input: [user("hi"), { type: "function_call", callId: "call_9", name: "t", arguments: "{}" }, { type: "function_call_output", callId: "call_9", output: "{}" }],
      responseFormat: { type: "text" },
    });
    const part = toGeminiRequest(req).contents[1].parts![0];
    expect(part.thoughtSignature).toBe(SIGNATURE_PLACEHOLDER);
  });

  it("asks for JSON with a schema when no tools are offered, and maps the tool choices", () => {
    const json = toGeminiRequest(LlmRequestSchema.parse({ input: [user("plan")], responseFormat: { type: "json", name: "plan", schema: { type: "object", properties: { a: { const: 1 } } } } }));
    expect(json.config).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { a: { enum: [1], type: "integer" } } } });
    const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];
    expect(toGeminiRequest(LlmRequestSchema.parse({ input: [user("x")], tools, toolChoice: "required" })).config.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(toGeminiRequest(LlmRequestSchema.parse({ input: [user("x")], tools, toolChoice: "auto" })).config.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(toGeminiRequest(LlmRequestSchema.parse({ input: [user("x")], tools, toolChoice: "none" })).config.tools).toBeUndefined();
  });

  it("refuses shapes Studio never sends", () => {
    expect(LlmRequestSchema.safeParse({ input: [{ type: "message", role: "hacker", content: [] }] }).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ input: [], tools: [{ name: "bad name!", description: "", parameters: {} }] }).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ input: Array.from({ length: 401 }, () => user("x")) }).success).toBe(false);
  });
});

describe("fromGeminiResponse", () => {
  it("returns the text as one message and each call with its signature packed into the call id", () => {
    const res = fromGeminiResponse(
      {
        responseId: "r1",
        modelVersion: "gemini-3.8-flash",
        candidates: [
          {
            finishReason: "STOP" as never,
            content: {
              role: "model",
              parts: [{ text: "thinking", thought: true }, { text: "Here " }, { text: "you go." }, { functionCall: { id: "call_7", name: "run_query", args: { input: { kind: "agg" } } }, thoughtSignature: "U0lH" }, { functionCall: { name: "plain", args: { a: 1 } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 3 },
      },
      new Set(["run_query"]),
      ids,
    );
    expect(res.status).toBe("completed");
    expect(res.output[0]).toMatchObject({ type: "message", content: [{ type: "text", text: "Here you go." }] });
    expect(res.output[1]).toMatchObject({ type: "function_call", name: "run_query", callId: "call_7~U0lH", arguments: '{"kind":"agg"}' });
    expect(res.output[2]).toMatchObject({ type: "function_call", name: "plain", arguments: '{"a":1}' });
    expect(unpackCallId(res.output[1].type === "function_call" ? res.output[1].callId : "")).toEqual({ id: "call_7", signature: "U0lH" });
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 });
  });

  it("reports a cut-off or blocked turn as incomplete", () => {
    expect(fromGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS" as never, content: { parts: [{ text: "partial" }] } }] }, new Set(), ids)).toMatchObject({
      status: "incomplete",
      incompleteDetails: { reason: "max_output_tokens" },
    });
    expect(fromGeminiResponse({ candidates: [{ finishReason: "SAFETY" as never, content: { parts: [] } }] }, new Set(), ids)).toMatchObject({
      status: "incomplete",
      incompleteDetails: { reason: "content_filter" },
      output: [],
    });
  });
});
