import { Bot, CreditCard, Link2, ShieldCheck, ShieldX, Store, User } from "lucide-react";
import { eventLabel } from "@/lib/rentals/status";
import type { AuditEvent } from "@/lib/rentals/types";
import { cx } from "./ui";

const ACTOR = {
  customer: { icon: User, label: "Customer", tone: "bg-brand-soft text-brand-ink" },
  staff: { icon: Store, label: "Counter", tone: "bg-line/70 text-ink-soft" },
  system: { icon: Link2, label: "System", tone: "bg-line/70 text-ink-soft" },
  paypal: { icon: CreditCard, label: "PayPal", tone: "bg-held-soft text-held" },
  ai: { icon: Bot, label: "AI", tone: "bg-note-soft text-note" },
} as const;

function detail(e: AuditEvent): string | null {
  const d = e.data as Record<string, unknown>;
  const ids = ["orderId", "captureId", "authorizationId", "disputeId"].map((k) => (typeof d[k] === "string" ? `${k.replace("Id", "")} ${d[k]}` : null)).filter(Boolean);
  if (e.type.startsWith("dispute.") && typeof d.status === "string") ids.push(String(d.outcome ?? d.status).toLowerCase().replace(/_/g, " "));
  if (typeof d.debugId === "string") ids.push(`debug_id ${d.debugId}`);
  if (typeof d.issue === "string") ids.push(String(d.issue));
  if (typeof d.sha256 === "string") ids.push(`sha256 ${d.sha256.slice(0, 12)}…`);
  if (e.type === "inspection.completed") ids.push(`${d.source} · ${d.model} · ${d.looks} looks · ${Math.round(Number(d.ms) / 100) / 10}s`);
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
              {extra && <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{extra}</p>}
              <p className="font-mono text-[10px] text-line-strong">#{e.hash.slice(0, 16)}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
