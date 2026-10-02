"use client";

import { CalendarRange, CheckCircle2, TriangleAlert } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { cx } from "@/components/ui";
import type { ScheduleProposal, ScheduleView } from "@/lib/schedule/view";
import { CommandBox } from "./command-box";
import { ProposalsPanel } from "./proposals-panel";

// Bryntum touches the DOM when it loads, so the timeline is loaded in the
// browser only, after the rest of the page has rendered on the server.
const Timeline = dynamic(() => import("./bryntum-timeline"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[640px] place-items-center rounded-[var(--radius-card)] border border-line bg-card text-sm text-muted">
      <span className="flex items-center gap-2">
        <CalendarRange className="h-4 w-4 animate-pulse-soft" aria-hidden /> Loading the schedule…
      </span>
    </div>
  ),
});

const LEGEND = [
  { label: "Booked, fee paid", swatch: "border-l-4 border-brand bg-brand-soft" },
  { label: "Deposit held", swatch: "border-l-4 border-held bg-held-soft" },
  { label: "Back, in review", swatch: "border-l-4 border-charged bg-[repeating-linear-gradient(135deg,var(--color-held-soft)_0_4px,var(--color-charged-soft)_4px_8px)]" },
  { label: "Settled", swatch: "border-l-4 border-released bg-released-soft" },
  { label: "Disputed", swatch: "border-l-4 border-charged bg-charged-soft" },
  { label: "In repair or blocked", swatch: "bg-[repeating-linear-gradient(135deg,var(--color-charged-soft)_0_4px,white_4px_8px)] border border-charged/30" },
  { label: "Agent's suggestion", swatch: "border-[1.5px] border-dashed border-brand bg-brand-soft/50" },
];

export function ScheduleBoard({ view }: { view: ScheduleView }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const focusProposal = (p: ScheduleProposal | null) => {
    if (!p) return;
    setSelected(p.id);
    const hasGhost = (p.kind === "reassign" || p.kind === "reschedule") && p.toUnitId;
    setFocus(hasGhost ? `ghost:${p.id}` : p.rentalId);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-4">
        <CommandBox ai={view.ai} onProposal={(id) => setSelected(id)} />
        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={cx(
              "flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium",
              notice.tone === "error" ? "bg-charged-soft text-charged" : "bg-released-soft text-released",
            )}
          >
            {notice.tone === "error" ? <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
            {notice.text}
          </p>
        )}
        <Timeline
          view={view}
          focus={focus}
          onNotice={setNotice}
          onPick={(proposalId, rentalId) => {
            setSelected(proposalId);
            setFocus(rentalId);
            if (proposalId) document.getElementById(`proposal-${proposalId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }}
        />
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-soft" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-2">
              <span className={cx("inline-block h-3.5 w-7 rounded-md", l.swatch)} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
      <ProposalsPanel pending={view.pending} decided={view.decided} selected={selected} onHover={focusProposal} />
    </div>
  );
}
