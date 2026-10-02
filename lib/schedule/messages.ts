import "server-only";
import { z } from "zod";
import { shortDate } from "@/lib/dates";
import { aiConfigured } from "@/lib/inspection/run";
import { generateJson } from "./gemini";
import type { Span } from "./spans";

/**
 * What a customer needs to hear about a proposed change. The message only
 * explains a decision the deterministic planner already made; Gemini may
 * word it, but every fact comes from here and the result is checked.
 */
export type MessageFacts = {
  shopName: string;
  customerName: string;
  itemName: string;
  kind: "reassign" | "reschedule" | "call";
  /** Why the booked unit cannot be used; "staff" when the counter chose to move it. */
  why: "repair" | "maintenance" | "double-booked" | "staff";
  booked: Span;
  /** For a reschedule: the dates on offer. */
  offered?: Span;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const dates = (s: Span) => (s.start === s.end ? shortDate(s.start) : `${shortDate(s.start)}–${shortDate(s.end)}`);
const WHY: Record<MessageFacts["why"], string> = {
  repair: "needs a repair",
  maintenance: "is booked in for maintenance",
  "double-booked": "was promised to two customers by mistake",
  staff: "has been swapped for another one",
};

/** The fallback, and what demo mode always shows. */
export function templateMessage(f: MessageFacts): string {
  const hi = `Hi ${firstName(f.customerName)}`;
  switch (f.kind) {
    case "reassign":
      if (f.why === "staff") {
        return `${hi}, a quick note from ${f.shopName}: we have set aside a different ${f.itemName} of the same model for you. Your booking for ${dates(f.booked)} is unchanged.`;
      }
      return `${hi}, a quick note from ${f.shopName}: the ${f.itemName} we set aside for you ${WHY[f.why]}, so we have reserved another one of the same model. Your booking for ${dates(f.booked)} is unchanged.`;
    case "reschedule":
      return `${hi}, this is ${f.shopName}. The ${f.itemName} you booked for ${dates(f.booked)} ${WHY[f.why]}, and no other one is free on those dates. The earliest we can offer is ${dates(f.offered!)}. We will call you to check whether that works for you.`;
    case "call":
      return `${hi}, this is ${f.shopName}. The ${f.itemName} you booked for ${dates(f.booked)} ${WHY[f.why]}, and we have no other one free around those dates. We will call you to talk through the options.`;
  }
}

const MONTH_DAY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/g;

/**
 * Deterministic checks on a drafted message. Returns what is wrong, or null.
 * The model must not invent dates, mention money or links, or promise
 * anything (a refund, a discount) that nobody decided.
 */
export function checkMessage(text: string, f: MessageFacts): string | null {
  const t = text.trim();
  if (t.length < 40 || t.length > 480) return "length";
  if (!t.includes(firstName(f.customerName))) return "missing the customer's name";
  if (/https?:|www\.|@/i.test(t)) return "contains a link or address";
  if (/[$€£]|\b\d+(?:\.\d+)?\s*(?:usd|dollars?)\b/i.test(t)) return "mentions money";
  if (/\b(?:refund\w*|discount\w*|free of charge|compensat\w*|vouchers?|credits?)\b/i.test(t)) return "promises something nobody decided";
  const allowed = new Set([f.booked.start, f.booked.end, f.offered?.start, f.offered?.end].filter(Boolean).map((d) => shortDate(d!)));
  for (const m of t.matchAll(MONTH_DAY)) {
    if (!allowed.has(`${m[1]} ${Number(m[2])}`)) return `mentions a date that is not part of the plan (${m[0]})`;
  }
  if (!t.includes(shortDate(f.booked.start))) return "missing the booked dates";
  if (f.kind === "reschedule" && !t.includes(shortDate(f.offered!.start))) return "missing the offered dates";
  return null;
}

const Drafted = z.object({ message: z.string().describe("the message to the customer, two or three short sentences") });

function prompt(f: MessageFacts): string {
  const facts = {
    shop: f.shopName,
    customer_first_name: firstName(f.customerName),
    item: f.itemName,
    booked_dates: dates(f.booked),
    what_happened: `the unit set aside for this customer ${WHY[f.why]}`,
    plan:
      f.kind === "reassign"
        ? "another unit of the same model is reserved for the same dates; nothing else changes"
        : f.kind === "reschedule"
          ? `no unit is free on the booked dates; the earliest dates on offer are ${dates(f.offered!)}; staff will call to check they work`
          : "no unit is free around the booked dates; staff will call to talk through the options",
  };
  return `You write short, warm, plain-English messages from a small rental shop to a customer.
Write the message for this change, using only these facts:
${JSON.stringify(facts, null, 2)}

Rules:
- Two or three short sentences, addressed to the customer by first name.
- Write every date exactly as given (for example "${dates(f.booked)}"). Do not mention any other date or weekday.
- Do not mention prices, money, refunds, discounts or anything the facts do not say.
- No links, no email addresses, no sign-off line.`;
}

export type Drafter = (prompt: string) => Promise<{ message: string } | null>;
const geminiDrafter: Drafter = (p) => generateJson(p, Drafted);

/**
 * Gemini words the message when a key is set (and not in demo mode); the
 * draft must pass checkMessage, otherwise the template is used.
 */
export async function draftMessage(f: MessageFacts, drafter: Drafter | null = aiConfigured() ? geminiDrafter : null) {
  if (drafter) {
    try {
      const drafted = await drafter(prompt(f));
      if (drafted && checkMessage(drafted.message, f) === null) return { text: drafted.message.trim(), source: "gemini" as const };
    } catch (err) {
      console.error("schedule message draft failed", err);
    }
  }
  return { text: templateMessage(f), source: "template" as const };
}
