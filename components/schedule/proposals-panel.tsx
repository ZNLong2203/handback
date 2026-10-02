"use client";

import { ArrowRightLeft, Bot, CalendarClock, Check, Copy, Keyboard, PhoneCall, Wrench, X } from "lucide-react";
import { useState } from "react";
import { approveProposalAction, rejectProposalAction } from "@/app/shop/schedule/actions";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, Eyebrow, cx } from "@/components/ui";
import type { ScheduleProposal } from "@/lib/schedule/view";

const first = (name: string | null) => name?.split(" ")[0] ?? "the customer";

function title(p: ScheduleProposal): string {
  switch (p.kind) {
    case "reassign":
      return `Move ${p.customerName} to ${p.toUnit}`;
    case "reschedule":
      return `Offer ${first(p.customerName)} ${p.newDates}`;
    case "call":
      return `Call ${p.customerName}`;
    case "block":
      return `Block ${p.toUnit}, ${p.dates}`;
  }
}

function approveLabel(p: ScheduleProposal): string {
  switch (p.kind) {
    case "reassign":
      return `Move to ${p.toUnit}`;
    case "reschedule":
      return `${first(p.customerName)} agreed: move to ${p.newDates}`;
    case "block":
      return "Add the block";
    case "call":
      return "";
  }
}

const ICON = { reassign: ArrowRightLeft, reschedule: CalendarClock, call: PhoneCall, block: Wrench } as const;

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted hover:bg-line/50 hover:text-ink"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        )
      }
    >
      <Copy className="h-3 w-3" aria-hidden /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ProposalCard({ p, selected, onHover }: { p: ScheduleProposal; selected: boolean; onHover: (p: ScheduleProposal | null) => void }) {
  const Icon = ICON[p.kind];
  return (
    <li
      id={`proposal-${p.id}`}
      data-testid="proposal"
      onMouseEnter={() => onHover(p)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(p)}
      className={cx(
        "animate-rise rounded-2xl border bg-card p-4 transition",
        selected ? "border-brand shadow-[var(--shadow-lift)]" : "border-line hover:border-ink/20",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", p.needsCall ? "bg-held-soft text-held" : "bg-brand-soft text-brand")}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {p.origin === "agent" ? (
              <Badge tone="brand">
                <Bot className="h-3 w-3" aria-hidden /> Agent
              </Badge>
            ) : (
              <Badge tone="note">
                <Keyboard className="h-3 w-3" aria-hidden /> Typed
              </Badge>
            )}
            {p.needsCall && <Badge tone="held">Call first</Badge>}
          </div>
          <h3 className="mt-1.5 font-display text-base font-bold leading-snug">{title(p)}</h3>
          {p.customerName && p.kind !== "block" && (
            <p className="text-xs text-muted">
              {p.itemName} · booked {p.dates}
              {p.fromUnit ? ` · now on ${p.fromUnit}` : ""}
            </p>
          )}
        </div>
      </div>

      {p.cause && <p className="mt-3 rounded-xl bg-charged-soft px-3 py-2 text-xs font-medium text-charged">{p.cause}</p>}
      {p.command && <p className="mt-3 rounded-xl bg-note-soft px-3 py-2 text-xs text-note">&ldquo;{p.command}&rdquo;</p>}
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{p.summary}</p>

      {p.message && (
        <div className="mt-3 rounded-xl border border-line bg-paper/70 px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <Eyebrow className="text-[10px]">Message for {first(p.customerName)}</Eyebrow>
            <span className="flex items-center gap-1">
              <span className="text-[11px] text-muted">{p.messageSource === "gemini" ? "Worded by Gemini, checked" : "Template"}</span>
              <CopyMessage text={p.message} />
            </span>
          </div>
          <p className="text-sm leading-relaxed text-ink" data-testid="proposal-message">
            {p.message}
          </p>
          <p className="mt-1.5 text-[11px] text-muted">Handback does not send this. Copy it into an email, a text or the phone call.</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-start gap-2">
        {p.kind !== "call" && (
          <ActionButton action={approveProposalAction.bind(null, p.id)} variant={p.needsCall ? "primary" : "brand"} size="sm" pendingLabel="Checking and applying…">
            <Check className="h-4 w-4" aria-hidden /> {approveLabel(p)}
          </ActionButton>
        )}
        <ActionButton
          action={rejectProposalAction.bind(null, p.id, p.kind === "call" ? "Handled by phone" : undefined)}
          variant={p.kind === "call" ? "primary" : "ghost"}
          size="sm"
          pendingLabel="Saving…"
        >
          {p.kind === "call" ? (
            <>
              <Check className="h-4 w-4" aria-hidden /> Handled by phone
            </>
          ) : (
            <>
              <X className="h-4 w-4" aria-hidden /> Turn down
            </>
          )}
        </ActionButton>
      </div>
    </li>
  );
}

const STATUS_TONE = { approved: "released", rejected: "neutral", superseded: "note", pending: "brand" } as const;
const STATUS_LABEL = { approved: "Approved", rejected: "Turned down", superseded: "Out of date", pending: "Pending" } as const;

export function ProposalsPanel({
  pending,
  decided,
  selected,
  onHover,
}: {
  pending: ScheduleProposal[];
  decided: ScheduleProposal[];
  selected: string | null;
  onHover: (p: ScheduleProposal | null) => void;
}) {
  return (
    <Card className="flex max-h-[calc(100vh-7rem)] flex-col overflow-hidden xl:sticky xl:top-6" aria-labelledby="proposals-title">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="proposals-title" className="font-display text-xl font-bold">
            Needs a decision
          </h2>
          <Badge tone={pending.length ? "brand" : "neutral"}>{pending.length}</Badge>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          The agent suggests; nothing on the schedule moves until you approve. Every approval runs the same checks as a drag.
        </p>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
            Nothing to decide. When a return is settled with damage or a missing part, the agent blocks that unit for the repair and lists here any booking it has to move.
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.map((p) => (
              <ProposalCard key={p.id} p={p} selected={p.id === selected} onHover={onHover} />
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <section>
            <Eyebrow className="mb-2">Recently decided</Eyebrow>
            <ul className="space-y-1.5">
              {decided.map((p) => (
                <li key={p.id} className="flex items-start gap-2 text-xs text-ink-soft">
                  <Badge tone={STATUS_TONE[p.status]} className="shrink-0">
                    {STATUS_LABEL[p.status]}
                  </Badge>
                  <span className="min-w-0 leading-snug">
                    {title(p)}
                    {p.decisionNote && p.status !== "approved" ? <span className="text-muted"> · {p.decisionNote}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
