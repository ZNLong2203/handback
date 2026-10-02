"use client";

import { Check, CircleHelp, Eye, HandCoins, Undo2 } from "lucide-react";
import { useState, useTransition } from "react";
import { resolveContestAction, respondAction, setStaffDecisionAction } from "@/app/actions";
import type { Box } from "@/lib/inspection/schema";
import { formatUsd } from "@/lib/money";
import { isCharged } from "@/lib/rentals/settlement";
import type { ReviewedFinding } from "@/lib/rentals/types";
import { Badge, Button, cx } from "./ui";

type Mode = "staff" | "customer" | "resolve" | "readonly";

const KIND: Record<ReviewedFinding["kind"], { label: string; tone: "charged" | "held" | "note" }> = {
  missing: { label: "Missing", tone: "charged" },
  new_damage: { label: "New damage", tone: "charged" },
  dirt: { label: "Needs cleaning", tone: "charged" },
  pre_existing: { label: "Already there at pickup", tone: "held" },
  wear: { label: "Normal wear", tone: "note" },
};

const isCharge = (f: ReviewedFinding) => f.decision !== "note" && Boolean(f.price);

function boxStyle(b: Box) {
  const [ymin, xmin, ymax, xmax] = b;
  return { top: `${ymin / 10}%`, left: `${xmin / 10}%`, height: `${(ymax - ymin) / 10}%`, width: `${(xmax - xmin) / 10}%` };
}

function Photo({
  sha,
  label,
  sub,
  findings,
  which,
  active,
  onPick,
}: {
  sha: string;
  label: string;
  sub?: string;
  findings: ReviewedFinding[];
  which: "before" | "after";
  active: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className="relative">
        {/* Content-addressed photo from our own API: next/image adds nothing here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/photos/${sha}`} alt={`${label} photo`} className="block w-full" />
        {findings.map((f, i) => {
          const box = which === "before" ? f.boxBefore : f.boxAfter;
          if (!box) return null;
          const charge = isCharge(f) && f.staff === "keep";
          const on = active === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onPick(f.id)}
              aria-label={`Finding ${i + 1}: ${f.item}`}
              style={boxStyle(box)}
              className={cx(
                "absolute rounded-lg border-[3px] transition",
                which === "before" && f.kind === "missing" ? "border-dashed" : "",
                charge ? "border-charged" : f.kind === "pre_existing" ? "border-held" : "border-note/70",
                on ? "shadow-[0_0_0_4px_rgb(255_255_255/0.85)]" : active ? "opacity-40" : "",
              )}
            >
              <span
                className={cx(
                  "absolute -left-3 -top-3 grid h-6 w-6 place-items-center rounded-full text-xs font-bold text-white shadow",
                  charge ? "bg-charged" : f.kind === "pre_existing" ? "bg-held" : "bg-note",
                )}
              >
                {i + 1}
              </span>
            </button>
          );
        })}
      </div>
      <figcaption className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
        <span className="font-semibold">{label}</span>
        {sub && <span className="font-mono text-xs text-muted">{sub}</span>}
      </figcaption>
    </figure>
  );
}

export function InspectionView({
  checkoutSha,
  checkinSha,
  findings,
  mode,
  rentalId,
  token,
}: {
  checkoutSha: string;
  checkinSha: string;
  findings: ReviewedFinding[];
  mode: Mode;
  rentalId?: string;
  token?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, { answer: "accept" | "contest"; note: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const charges = findings.filter((f) => isCharge(f) && f.staff === "keep");
  const unanswered = charges.filter((f) => !answers[f.id] || (answers[f.id].answer === "contest" && !answers[f.id].note.trim()));

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
    });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Photo sha={checkoutSha} label="At pickup" sub={`sha256 ${checkoutSha.slice(0, 10)}…`} findings={findings} which="before" active={active} onPick={setActive} />
        <Photo sha={checkinSha} label="At return" sub={`sha256 ${checkinSha.slice(0, 10)}…`} findings={findings} which="after" active={active} onPick={setActive} />
      </div>

      {findings.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-released/25 bg-released-soft px-4 py-3 text-sm text-released">
          <Check className="h-5 w-5" aria-hidden />
          <span>
            <strong>Nothing changed.</strong> Both looks agree the item came back as it left.
          </span>
        </div>
      ) : (
        <ol className="space-y-3">
          {findings.map((f, i) => {
            const kind = KIND[f.kind];
            const charge = isCharge(f);
            const a = answers[f.id];
            return (
              <li
                key={f.id}
                onMouseEnter={() => setActive(f.id)}
                onMouseLeave={() => setActive(null)}
                className={cx(
                  "rounded-2xl border bg-card p-4 transition",
                  active === f.id ? "border-ink/30 shadow-[var(--shadow-card)]" : "border-line",
                  charge && f.staff === "waive" ? "opacity-60" : "",
                )}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <span
                    className={cx(
                      "grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold text-white",
                      charge && f.staff === "keep" ? "bg-charged" : f.kind === "pre_existing" ? "bg-held" : "bg-note",
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={kind.tone}>{kind.label}</Badge>
                      <span className="font-semibold capitalize">{f.item}</span>
                      {charge && f.price && (
                        <span className="ml-auto text-right">
                          <span className={cx("tabular font-semibold", f.staff === "waive" ? "text-muted line-through" : "text-charged")}>
                            {formatUsd(f.price.cents)}
                          </span>
                          <span className="block text-xs text-muted">{f.price.label}</span>
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{f.description}</p>
                    <details className="mt-1.5 text-sm text-muted">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-ink">
                        <Eye className="h-3.5 w-3.5" aria-hidden /> Why
                      </summary>
                      <p className="mt-1 leading-relaxed">{f.evidence}</p>
                      <p className="mt-1 leading-relaxed">
                        {f.reason} Confidence: {f.confidence}.
                      </p>
                    </details>

                    {mode === "staff" && charge && (
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant={f.staff === "keep" ? "charged" : "outline"}
                          disabled={pending}
                          onClick={() => act(() => setStaffDecisionAction(rentalId!, f.id, "keep"))}
                        >
                          <HandCoins className="h-4 w-4" aria-hidden /> Keep
                        </Button>
                        <Button
                          size="sm"
                          variant={f.staff === "waive" ? "primary" : "outline"}
                          disabled={pending}
                          onClick={() => act(() => setStaffDecisionAction(rentalId!, f.id, "waive"))}
                        >
                          <Undo2 className="h-4 w-4" aria-hidden /> Waive
                        </Button>
                      </div>
                    )}

                    {mode === "customer" && charge && f.staff === "keep" && (
                      <fieldset className="mt-3">
                        <legend className="sr-only">Your answer for {f.item}</legend>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            type="button"
                            variant={a?.answer === "accept" ? "primary" : "outline"}
                            aria-pressed={a?.answer === "accept"}
                            onClick={() => setAnswers((s) => ({ ...s, [f.id]: { answer: "accept", note: "" } }))}
                          >
                            <Check className="h-4 w-4" aria-hidden /> That&apos;s fair
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant={a?.answer === "contest" ? "primary" : "outline"}
                            aria-pressed={a?.answer === "contest"}
                            onClick={() => setAnswers((s) => ({ ...s, [f.id]: { answer: "contest", note: s[f.id]?.note ?? "" } }))}
                          >
                            <CircleHelp className="h-4 w-4" aria-hidden /> I question this
                          </Button>
                        </div>
                        {a?.answer === "contest" && (
                          <label className="mt-2 block text-sm">
                            <span className="text-muted">What happened? The shop reads this before deciding.</span>
                            <textarea
                              value={a.note}
                              onChange={(e) => setAnswers((s) => ({ ...s, [f.id]: { answer: "contest", note: e.target.value } }))}
                              rows={2}
                              maxLength={500}
                              className="mt-1 w-full rounded-xl border border-line-strong bg-paper px-3 py-2 text-ink"
                            />
                          </label>
                        )}
                      </fieldset>
                    )}

                    {(mode === "resolve" || mode === "readonly") && f.customer && (
                      <div className="mt-3 rounded-xl bg-paper px-3 py-2 text-sm">
                        <span className="font-semibold">{f.customer === "accept" ? "Customer accepted." : "Customer questioned this:"}</span>
                        {f.customerNote && <q className="ml-1 text-ink-soft">{f.customerNote}</q>}
                      </div>
                    )}

                    {mode === "resolve" && f.customer === "contest" && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={f.resolution === "waive" ? "released" : "outline"}
                          disabled={pending}
                          onClick={() => act(() => resolveContestAction(rentalId!, f.id, "waive"))}
                        >
                          <Undo2 className="h-4 w-4" aria-hidden /> Waive it
                        </Button>
                        <Button
                          size="sm"
                          variant={f.resolution === "charge" ? "charged" : "outline"}
                          disabled={pending}
                          onClick={() => act(() => resolveContestAction(rentalId!, f.id, "charge"))}
                        >
                          <HandCoins className="h-4 w-4" aria-hidden /> Keep the charge
                        </Button>
                      </div>
                    )}

                    {mode === "readonly" && charge && (
                      <p className={cx("mt-2 text-sm font-semibold", isCharged(f) ? "text-charged" : "text-released")}>
                        {isCharged(f) ? `Charged ${formatUsd(f.price!.cents)}` : "Not charged"}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {mode === "customer" && charges.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="brand"
            size="lg"
            disabled={pending || unanswered.length > 0}
            onClick={() =>
              act(() =>
                respondAction(
                  token!,
                  charges.map((f) => ({ findingId: f.id, answer: answers[f.id].answer, note: answers[f.id].note.trim() || undefined })),
                ),
              )
            }
          >
            Send my answers
          </Button>
          <span className="text-sm text-muted">
            {unanswered.length > 0 ? `Answer ${unanswered.length} more item${unanswered.length > 1 ? "s" : ""}.` : "Nothing is charged until the shop reads your answers."}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-charged">
          {error}
        </p>
      )}
    </div>
  );
}
