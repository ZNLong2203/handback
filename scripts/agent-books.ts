/**
 * An assistant books a rental through Handback's MCP server, the way Claude
 * Desktop or any MCP client would: it reads the tools from /api/mcp, lets a
 * model call them, and ends with a PayPal approval link for the person.
 * Nothing here can pay. The person approves in PayPal; the shop settles.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/agent-books.ts "rent a drone this weekend for Sam, sam@example.com"
 *
 * Uses Claude when ANTHROPIC_API_KEY is set, Gemini (GEMINI_API_KEY) otherwise;
 * AGENT_MODEL overrides the model. MCP_URL defaults to $APP_URL/api/mcp.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mcpTools, type MCPCallToolResultLike, type MCPClientLike } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const request = process.argv.slice(2).join(" ") || "Rent a drone this weekend for Sam, sam@example.com";
const endpoint = process.env.MCP_URL ?? `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/mcp`;
const MAX_TURNS = 10;

const mcp = new Client({ name: "handback-agent-demo", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
const { tools } = await mcp.listTools();

const textOf = (res: MCPCallToolResultLike) => res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
let booking: Record<string, unknown> | undefined;

/** Every tool call goes through here, so each one is printed and the booking is kept for the end. */
const traced: MCPClientLike = {
  async callTool({ name, arguments: args }) {
    console.log(`\n-> ${name} ${JSON.stringify(args ?? {})}`);
    const res = (await mcp.callTool({ name, arguments: args })) as MCPCallToolResultLike;
    const out = textOf(res);
    console.log(res.isError ? `   refused: ${out}` : `   ${out.length > 300 ? `${out.slice(0, 300).replace(/\s+/g, " ")}…` : out.replace(/\s+/g, " ")}`);
    if (name === "create_booking" && !res.isError) booking = res.structuredContent as Record<string, unknown>;
    return res;
  },
};

const viaClaude = Boolean(process.env.ANTHROPIC_API_KEY);
const system = [
  mcp.getInstructions() ?? "",
  `You are ${viaClaude ? "Claude" : "Gemini"}, acting for the person below. They asked you to make this booking and approve the payment ` +
    "themselves in PayPal, so book it without asking them to confirm first. Work out relative dates from the shop's date. End with a " +
    "short plain-text message to them: what you booked, the fee, the deposit hold and when it happens, and the PayPal approval link.",
].join("\n\n");

async function withClaude(): Promise<string> {
  const anthropic = new Anthropic();
  const final = await anthropic.beta.messages.toolRunner({
    model: process.env.AGENT_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // If a safety classifier declines, the API retries on the model it recommends.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    tools: mcpTools(tools, traced),
    messages: [{ role: "user", content: request }],
    max_iterations: MAX_TURNS,
  });
  if (final.stop_reason === "refusal") return "Claude declined this request.";
  return final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

async function withGemini(): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  // Gemini takes the tool's JSON Schema as is, minus the $schema marker.
  const functionDeclarations = tools.map(({ name, description, inputSchema }) => {
    const parameters: Record<string, unknown> = { ...inputSchema };
    delete parameters.$schema;
    return { name, description, parametersJsonSchema: parameters };
  });
  const contents: Content[] = [{ role: "user", parts: [{ text: request }] }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await ai.models.generateContent({
      model: process.env.AGENT_MODEL || "gemini-3.8-flash",
      contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations }], thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
    });
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) return res.text ?? "";
    // The model's turn goes back unchanged: it carries the thought signatures Gemini needs.
    contents.push(res.candidates![0].content!);
    const parts: Part[] = [];
    for (const call of calls) {
      const out = await traced.callTool({ name: call.name!, arguments: call.args });
      const response = out.isError ? { error: textOf(out) } : { output: out.structuredContent ?? textOf(out) };
      parts.push({ functionResponse: { id: call.id, name: call.name, response } });
    }
    contents.push({ role: "user", parts });
  }
  throw new Error(`The model was still calling tools after ${MAX_TURNS} turns.`);
}

if (!viaClaude && !process.env.GEMINI_API_KEY) throw new Error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY.");
console.log(`Asking ${viaClaude ? "Claude" : "Gemini"}, with the tools at ${endpoint}:\n"${request}"`);
const reply = viaClaude ? await withClaude() : await withGemini();
console.log(`\n${reply.trim()}`);

if (booking) {
  console.log(`\nPayPal approval link, for the person to open: ${booking.approveUrl}`);
  console.log(`Their rental page: ${booking.rentalPageUrl}`);
  console.log(`\nDeposit mandate (sha256 ${booking.mandateSha256}):`);
  console.log(JSON.stringify(booking.mandate, null, 2));
} else {
  console.log("\nNo booking was made.");
}
await mcp.close();
