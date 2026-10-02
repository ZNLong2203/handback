"use client";

import { Check, CornerDownLeft, Loader2, Sparkles, X } from "lucide-react";
import { useState, useTransition } from "react";
import { approveProposalAction, commandAction, rejectProposalAction, type CommandReply } from "@/app/shop/schedule/actions";
import { Button, cx } from "@/components/ui";

const EXAMPLES = ["Move Maya's drone booking to the other unit", "Block Projector B for 2 days for a lens clean"];

/**
 * A typed request becomes at most one suggestion, which still has to be
 * confirmed here (or in the panel). The words go to the server; the server
 * builds the prompt, checks the answer, and applies nothing on its own.
 */
export function CommandBox({ ai, onProposal }: { ai: boolean; onProposal: (proposalId: string | null) => void }) {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<CommandReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ask = () =>
    startTransition(async () => {
      setError(null);
      setDone(null);
      setReply(null);
      const res = await commandAction(text);
      if (!res.ok) return setError(res.error);
      setReply(res.data);
      onProposal(res.data.proposalId);
    });

  const decide = (approve: boolean) =>
    startTransition(async () => {
      if (!reply?.proposalId) return;
      const res = approve ? await approveProposalAction(reply.proposalId) : await rejectProposalAction(reply.proposalId, "Cancelled after typing");
      if (!res.ok) return setError(res.error);
      setDone(approve ? "Done. The schedule has been updated." : "Cancelled. Nothing changed.");
      setReply(null);
      setText("");
      onProposal(null);
    });

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-card p-4 shadow-[var(--shadow-card)]">
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) ask();
        }}
      >
        <label htmlFor="schedule-command" className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-brand" aria-hidden /> Tell the schedule
        </label>
        <input
          id="schedule-command"
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLES[0]}
          className="h-11 min-w-0 flex-1 rounded-full border border-line-strong bg-paper px-4 text-sm text-ink placeholder:text-muted"
          autoComplete="off"
        />
        <Button type="submit" variant="brand" disabled={pending || !text.trim()}>
          {pending && !reply ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CornerDownLeft className="h-4 w-4" aria-hidden />}
          Suggest
        </Button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{ai ? "Gemini turns this into one schedule action." : "No AI key here (or demo mode): a simple parser reads it."} You confirm before anything changes.</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" onClick={() => setText(ex)} className="rounded-full bg-line/50 px-2.5 py-0.5 text-ink-soft hover:bg-line">
            {ex}
          </button>
        ))}
      </div>

      {reply && (
        <div
          className={cx("mt-3 rounded-2xl px-4 py-3 text-sm", reply.kind === "proposal" ? "bg-brand-soft" : reply.kind === "question" ? "bg-note-soft" : "bg-charged-soft")}
          role="status"
          data-testid="command-reply"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            {reply.kind === "proposal"
              ? reply.via === "gemini"
                ? "Gemini read it as"
                : "Read without AI as"
              : reply.kind === "question"
                ? reply.via === "gemini"
                  ? "Gemini asks"
                  : "Not sure what you mean"
                : "Not possible, nothing changed"}
          </p>
          <p className="mt-1 leading-relaxed text-ink">{reply.text}</p>
          {reply.proposalId && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="brand" disabled={pending} onClick={() => decide(true)}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Confirm
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(false)}>
                <X className="h-4 w-4" aria-hidden /> Cancel
              </Button>
            </div>
          )}
        </div>
      )}
      {done && (
        <p className="mt-3 text-sm font-medium text-released" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm font-medium text-charged" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
