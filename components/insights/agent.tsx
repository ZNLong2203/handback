"use client";

import type { AgAiEvent, AgAiHarnessSetup, AgAiPromptStarter, AgAiTool, AgAiToolDetailParams, AgAiToolLabelParams, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgStudioApi } from "ag-studio";
import { createAiHarness, directLlmRunner } from "ag-studio";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { SHOP } from "@/lib/shop";

/**
 * The Studio Agent Framework on the owner's dashboard.
 *
 *   - Studio's five built-in agents (lead, planning, data, page, widget) run
 *     on Gemini through a staff-only server route (/api/insights/llm): the
 *     adapter below posts each turn there, so the key stays on the server.
 *   - A custom agent, the deposit desk, fronts the conversation. It has three
 *     tools of its own that run on the server's record
 *     (/api/insights/tools): holds_needing_attention, explain_rental and
 *     draft_refund. It hands "show me / add a chart" requests to Studio's
 *     lead agent, which places and configures widgets with the page and
 *     widget agents.
 *   - draft_refund cannot refund: the server checks the amount against the
 *     same limits as the counter's refund and returns a link to the rental
 *     page with the form filled in; a person sends it from there.
 */

// ─── The adapter: one turn, through our server ───────────────

type TurnReply = { response?: AgLlmResponse; error?: string };

/** AG Studio's AgLlmAdapter for Gemini, proxied: the browser never sees the key. */
export function geminiProxyAdapter(endpoint = "/api/insights/llm"): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options) {
      // Started at once, so `complete` settles whether or not the stream is read.
      const reply: Promise<AgLlmResponse> = fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: { ...request, tools: request.tools?.filter((t) => t.kind !== "provided") } }),
        signal: options?.signal,
      }).then(async (res) => {
        const body = (await res.json().catch(() => null)) as TurnReply | null;
        if (!res.ok || !body?.response) throw new Error(body?.error ?? `The assistant's server answered ${res.status}.`);
        return body.response;
      });
      reply.catch(() => {});
      async function* events(): AsyncGenerator<AgAiEvent> {
        let response: AgLlmResponse;
        try {
          response = await reply;
        } catch {
          return; // The failure is reported once, on `complete`.
        }
        for (const item of response.output) {
          if (item.type === "message") {
            const text = item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
            yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
            yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text };
            yield { type: "TEXT_MESSAGE_END", messageId: item.id };
          } else if (item.type === "function_call") {
            yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name };
            yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
            yield { type: "TOOL_CALL_END", toolCallId: item.callId };
          }
        }
      }
      const it = events();
      return { stream: { [Symbol.asyncIterator]: () => it }, complete: reply };
    },
  };
}

// ─── The deposit desk's tools ────────────────────────────────

type ToolReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string; issues?: string[] };

async function callTool(tool: string, args: unknown, signal: AbortSignal): Promise<ToolReply> {
  const res = await fetch("/api/insights/tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, args }), signal });
  const body = (await res.json().catch(() => null)) as ToolReply | null;
  if (!body) return { ok: false, error: `The server answered ${res.status}.` };
  if (res.status === 401) return { ok: false, error: "Staff sign-in needed: sign in at the counter again." };
  return body;
}

function deskTools(api: AgStudioApi): AgAiTool[] {
  const run = async (tool: string, args: unknown, ctx: { signal: AbortSignal; success: (r: string, d?: unknown) => never; error: (m: string | string[]) => never }) => {
    const reply = await callTool(tool, args, ctx.signal);
    return reply.ok ? ctx.success(JSON.stringify(reply.result), reply.result) : ctx.error([reply.error, ...(reply.issues ?? [])]);
  };
  return [
    api.defineAiTool({
      name: "holds_needing_attention",
      description:
        "Lists the deposit holds running on PayPal now, with the 29-day clock of each (held at, 72-hour honor period, renewal due, renewed, expiry) and why a person should look at one: expiring within 3 days, a missed renewal, an overdue item, or a renter who answered and can be settled. Read-only.",
      params: (s) => s.object({ include_all: s.boolean({ description: "true to list every running hold, not only those needing attention." }).optional() }),
      execute: (args, ctx) => run("holds_needing_attention", args, ctx as never),
    }),
    api.defineAiTool({
      name: "explain_rental",
      description:
        "Explains one rental from the server's record: the money (fee, hold, what was kept, released, refunded, what is left to refund, every PayPal id), the AI findings with their price-list entry and outcome, PayPal disputes, and the hash-chained audit trail. Read-only.",
      params: (s) => s.object({ rental_id: s.string({ description: "The rental id, like R-7KQ2MX. Find ids with execute_query on rentals.rental_id." }) }),
      execute: (args, ctx) => run("explain_rental", args, ctx as never),
    }),
    api.defineAiTool({
      name: "draft_refund",
      description:
        "Prepares a refund proposal for a settled rental, or for a booking cancelled after it was paid, checked against the same limits as the counter's refund form (no open dispute; at most what is left on the capture after earlier refunds and money a dispute returned). It does NOT refund: it returns a link to the rental page with the form filled in, where a person presses Refund and confirms. Never say a refund was sent.",
      params: (s) =>
        s.object({
          rental_id: s.string({ description: "The rental id, like R-7KQ2MX." }),
          amount_cents: s.number({ description: "Whole US cents: 500 means $5.00." }),
          reason: s.string({ description: "Why, in a sentence the renter will read on their page and in PayPal's email. Under 200 characters, no names." }),
          capture_id: s.string({ description: "Optional PayPal capture id, when the rental has two refundable captures." }).optional(),
        }),
      execute: (args, ctx) => run("draft_refund", args, ctx as never),
    }),
  ];
}

const DESK_INSTRUCTIONS = (api: AgStudioApi) => {
  const tables = api
    .getAiContext()
    .schema()
    .tables.map((t) => t.name)
    .join(", ");
  return `You are the deposit desk for ${SHOP.name}, a small rental shop. The shop takes the rental fee with PayPal at booking, holds a refundable deposit on the renter's saved PayPal account at pickup (an authorization: reserved, not taken), and at return keeps only the repair charges the renter accepted or staff upheld, releasing the rest. The owner asks you where deposit money went, what was kept and why, and which holds need attention.

Today is ${new Date().toISOString().slice(0, 10)} (UTC). The dashboard's tables: ${tables}.

How you work:
- Holds, deadlines, renewals: call holds_needing_attention.
- One rental's story (money, findings, disputes, audit trail): call explain_rental with its id. Find ids with execute_query on the rentals table (rental_id, item, renter, status).
- Totals and breakdowns: use execute_query, or delegate to the data agent.
- Anything to show, chart, add, move, resize or filter on the dashboard: delegate to the lead agent with one clear task that names the table and field ids to use, for example "Add a bar chart of findings.charged_usd (sum) by findings.price_entry". Do not try to build widgets yourself.
- Refunds: you can only draft one with draft_refund. It sends nothing. After drafting, give the amount, the rental and the link from the result, and say a person must open it and press Refund. Never say or imply that money was refunded. If the result has a warning (it looks like an earlier refund), say so first. If the tool refuses, say why in plain words.
- PayPal facts you can rely on: a hold lasts 29 days from the first authorization; from 72 hours it may be renewed once; a renewed hold keeps the first expiry. The shop's hourly job renews the day before the item is due back, never before 72 hours.

Style: short, plain sentences. Dollars with two decimals. Quote PayPal ids and rental ids exactly. Name renters by first name only, never by email.`;
};

export const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: "Holds needing attention", prompt: "Which deposit holds need attention right now, and why?" },
  { label: "Chart what we kept", prompt: "Add a bar chart to this page of what we charged by price-list entry." },
  { label: "Explain a dispute", prompt: "Explain what happened to the money on the rental that has an open PayPal dispute." },
  { label: "Draft a refund", prompt: "Draft a $15.00 refund on the PA speaker rental with the dented grille: the dent is cosmetic and the speaker works." },
];

export function depositDeskHarness(): AgAiHarnessSetup {
  const adapter = geminiProxyAdapter();
  return ({ api }) =>
    createAiHarness(api, ({ builtIn }) => ({
      agents: [
        ...Object.values(builtIn).map((definition) => directLlmRunner({ ...definition, adapter })),
        directLlmRunner({
          id: "deposit-desk",
          name: "Deposit desk",
          description: "Answers the owner's questions about deposit money, holds and refunds from the shop's record, and drafts refunds for a person to send.",
          schema: (s) => s.undefined(),
          instructions: () => DESK_INSTRUCTIONS(api),
          tools: ({ studio, tools }) => [...deskTools(api), studio.viewSchema(), studio.viewPage(), studio.executeQuery(), tools.delegateTo(["lead", "data"])],
          maxTurns: 24,
          adapter,
        }),
      ],
      primary: "deposit-desk",
      promptStarters: PROMPT_STARTERS,
    }));
}

// ─── How the desk's tool calls look in the chat panel ────────

type Draft = { amount: string; rental_id: string; item: string; renter: string; of: string; reason: string; left_after: string; confirm_at: string; warning?: string };
type Holds = { needing_attention: number; running_holds: number; held_total: string; holds: { rental_id: string; item: string; held: string; state: string; attention: string | null; days_left: number }[] };

function DraftCard(params: AgAiToolDetailParams<Record<string, unknown>, Draft>) {
  const d = params.result?.success ? params.result.data : undefined;
  if (!d) return null;
  return (
    <div className="space-y-2 rounded-xl border border-[var(--ag-border-color)] p-3 text-[13px]" data-testid="refund-draft">
      <p className="font-semibold">
        Draft: refund {d.amount} of {d.of} on {d.rental_id}
      </p>
      <p className="opacity-80">
        {d.item}, {d.renter}. &ldquo;{d.reason}&rdquo; {d.left_after} would be left to refund.
      </p>
      {d.warning && (
        <p className="font-semibold" role="note">
          {d.warning}
        </p>
      )}
      <p className="flex items-center gap-1.5 text-[12px] opacity-80">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Not sent. Nothing reaches PayPal until a person presses Refund on the rental page.
      </p>
      <Link href={d.confirm_at} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
        Open {d.rental_id} to check and send <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function HoldsCard(params: AgAiToolDetailParams<Record<string, unknown>, Holds>) {
  const d = params.result?.success ? params.result.data : undefined;
  if (!d) return null;
  return (
    <ul className="space-y-1.5 text-[13px]">
      {d.holds.map((h) => (
        <li key={h.rental_id}>
          <Link href={`/shop/rentals/${h.rental_id}`} className="font-semibold underline underline-offset-2">
            {h.rental_id}
          </Link>{" "}
          {h.item}, {h.held}: {h.state}, {h.days_left} days left.
          {h.attention ? <span className="block opacity-80">{h.attention}</span> : null}
        </li>
      ))}
      {d.holds.length === 0 && <li>No running hold needs a person now.</li>}
    </ul>
  );
}

const done = (p: AgAiToolLabelParams) => p.result !== undefined;

export const depositDeskDisplay = {
  holds_needing_attention: {
    label: (p: AgAiToolLabelParams<Record<string, unknown>, Holds>) => ({
      text: done(p) ? "Checked the running holds" : "Checking the running holds",
      pill: p.result?.success && p.result.data ? `${p.result.data.needing_attention} of ${p.result.data.running_holds} need you` : undefined,
    }),
    detail: HoldsCard,
  },
  explain_rental: {
    label: (p: AgAiToolLabelParams<{ rental_id?: string }>) => ({ text: `${done(p) ? "Read" : "Reading"} the record of ${p.args.rental_id ?? "a rental"}` }),
  },
  draft_refund: {
    label: (p: AgAiToolLabelParams<{ rental_id?: string; amount_cents?: number }, Draft>) => ({
      text: `${done(p) ? "Drafted" : "Drafting"} a refund${p.args.rental_id ? ` on ${p.args.rental_id}` : ""}`,
      pill: p.result?.success ? "not sent" : p.result ? "refused" : undefined,
    }),
    detail: DraftCard,
  },
};
