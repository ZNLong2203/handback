import { Bot, BotMessageSquare, CreditCard, Link2, ShieldCheck, ShieldX, Store, User } from "lucide-react";
import { formatUsd } from "@/lib/money";
import { eventLabel } from "@/lib/rentals/status";
import type { AuditEvent } from "@/lib/rentals/types";
import { cx } from "./ui";

const ACTOR = {
  customer: { icon: User, label: "Customer", tone: "bg-brand-soft text-brand-ink" },
  assistant: { icon: BotMessageSquare, label: "Customer's assistant", tone: "bg-brand-soft text-brand-ink" },
  staff: { icon: Store, label: "Counter", tone: "bg-line/70 text-ink-soft" },
  system: { icon: Link2, label: "System", tone: "bg-line/70 text-ink-soft" },
  paypal: { icon: CreditCard, label: "PayPal", tone: "bg-held-soft text-held" },
  ai: { icon: Bot, label: "AI", tone: "bg-note-soft text-note" },
} as const;

const MOVED_VIA: Record<string, string> = { drag: "dragged on the schedule", agent: "agent's suggestion, approved", command: "typed request, confirmed" };

function detail(e: AuditEvent): string | null {
  const d = e.data as Record<string, unknown>;
  const ids = ["orderId", "captureId", "authorizationId", "disputeId", "refundId"].map((k) => (typeof d[k] === "string" ? `${k.replace("Id", "")} ${d[k]}` : null)).filter(Boolean);
  if (e.type.startsWith("dispute.") && typeof d.status === "string") ids.push(String(d.outcome ?? d.status).toLowerCase().replace(/_/g, " "));
  if (e.type.startsWith("refund.") && typeof d.amountCents === "number") ids.unshift(formatUsd(d.amountCents));
  if (typeof d.debugId === "string") ids.push(`debug_id ${d.debugId}`);
  if (d.confirmedByRead === true) ids.push("reply lost; confirmed by reading the dispute");
  if (d.confirmedBy === "webhook") ids.push("reply lost; confirmed by PayPal's webhook");
  if (typeof d.issue === "string") ids.push(String(d.issue));
  if (typeof d.sha256 === "string") ids.push(`sha256 ${d.sha256.slice(0, 12)}…`);
  if (e.type === "inspection.completed") ids.push(`${d.source} · ${d.model} · ${d.looks} looks · ${Math.round(Number(d.ms) / 100) / 10}s`);
  if (d.worker === "render-workflows") ids.push(typeof d.taskRunId === "string" ? `Render Workflows run ${d.taskRunId}` : "Render Workflows");
  if (e.type === "mandate.issued") ids.push(d.issuedTo === "assistant" ? "issued to an assistant acting for the renter" : "issued to the renter");
  if (Array.isArray(d.problems)) ids.push(...d.problems.map(String));
  if (e.type === "schedule.moved") ids.push(`${d.from} → ${d.to} · ${MOVED_VIA[String(d.via)] ?? String(d.via)}`);
  if (e.type === "booking.cancelled") {
    ids.push(`by ${d.by === "staff" ? "the counter" : "the renter"}`);
    if (d.paid) ids.push(`${formatUsd(Number(d.refundCents))} of the ${formatUsd(Number(d.feeCents))} fee to refund (policy: ${d.policyPercent}%)`);
    else ids.push("nothing was paid");
  }
  if (e.type === "repair.blocked") ids.push(`${d.unitId} · ${d.startDate} to ${d.endDate}`);
  return ids.length ? ids.join(" · ") : null;
}

export function Timeline({ events, intact }: { events: AuditEvent[]; intact: boolean }) {
  return (
    <div>
      <div className={cx("mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium", intact ? "bg-released-soft text-released" : "bg-charged-soft text-charged")}>
        {intact ? <ShieldCheck className="h-4 w-4" aria-hidden /> : <ShieldX className="h-4 w-4" aria-hidden />}
        {intact ? `Audit chain intact: ${events.length} entries, each hash covers the one before.` : "Audit chain broken: an entry was changed."}
      </div>
      <ol className="relative space-y-3 border-l border-line pl-5">
        {events.map((e) => {
          const actor = ACTOR[e.actor];
          const Icon = actor.icon;
          const extra = detail(e);
          return (
            <li key={e.seq} className="relative">
              <span className={cx("absolute -left-[31px] top-0.5 grid h-5 w-5 place-items-center rounded-full", actor.tone)}>
                <Icon className="h-3 w-3" aria-hidden />
              </span>
              <p className="text-sm font-medium leading-snug">{eventLabel(e.type)}</p>
              <p className="text-xs text-muted">
                {actor.label} · {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
              {/* Long ids may break anywhere; words such as "renter" stay whole. */}
              {extra && <p className="mt-0.5 font-mono text-[11px] text-muted [overflow-wrap:anywhere]">{extra}</p>}
              <p className="font-mono text-[10px] text-muted">#{e.hash.slice(0, 16)}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
