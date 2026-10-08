import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { formatUsd } from "@/lib/money";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

type Tone = "brand" | "held" | "released" | "charged" | "note" | "neutral";

const toneBadge: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand-ink",
  held: "bg-held-soft text-held-ink",
  released: "bg-released-soft text-released",
  charged: "bg-charged-soft text-charged",
  note: "bg-note-soft text-note",
  neutral: "bg-line/60 text-ink-soft",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", toneBadge[tone], className)}>
      {children}
    </span>
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cx("rounded-[var(--radius-card)] border border-line bg-card shadow-[var(--shadow-card)]", className)} {...rest}>
      {children}
    </section>
  );
}

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-full text-center font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
const buttonVariant = {
  primary: "bg-ink text-white hover:bg-ink-soft",
  brand: "bg-brand text-white hover:bg-brand-ink",
  released: "bg-released text-white hover:brightness-110",
  charged: "bg-charged text-white hover:brightness-110",
  outline: "border border-line-strong bg-card text-ink hover:border-ink/40",
  ghost: "text-ink-soft hover:bg-line/50",
} as const;
// A minimum height, not a fixed one: a label that wraps on a phone grows the button instead of spilling out of it.
const buttonSize = { sm: "min-h-9 px-4 py-1.5 text-sm", md: "min-h-11 px-5 py-2 text-sm", lg: "min-h-13 px-7 py-2.5 text-base" } as const;

type ButtonStyle = { variant?: keyof typeof buttonVariant; size?: keyof typeof buttonSize };

export function Button({ variant = "primary", size = "md", className, ...rest }: ComponentProps<"button"> & ButtonStyle) {
  return <button className={cx(buttonBase, buttonVariant[variant], buttonSize[size], className)} {...rest} />;
}

export function ButtonLink({ variant = "primary", size = "md", className, ...rest }: ComponentProps<typeof Link> & ButtonStyle) {
  return <Link className={cx(buttonBase, buttonVariant[variant], buttonSize[size], className)} {...rest} />;
}

/** A plain link styled as a button: a full page load that is never prefetched. For PayPal approval and its returns. */
export function ButtonAnchor({ variant = "primary", size = "md", className, ...rest }: ComponentProps<"a"> & ButtonStyle) {
  return <a className={cx(buttonBase, buttonVariant[variant], buttonSize[size], className)} {...rest} />;
}

export function Money({ cents, className }: { cents: number; className?: string }) {
  return <span className={cx("tabular", className)}>{formatUsd(cents)}</span>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-xs font-semibold uppercase tracking-[0.14em] text-muted", className)}>{children}</p>;
}

export function Notice({ tone = "note", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const ring: Record<Tone, string> = {
    brand: "border-brand/20 bg-brand-soft",
    held: "border-held/25 bg-held-soft",
    released: "border-released/25 bg-released-soft",
    charged: "border-charged/25 bg-charged-soft",
    note: "border-note/15 bg-note-soft",
    neutral: "border-line bg-card",
  };
  return (
    <div className={cx("rounded-2xl border px-4 py-3 text-sm leading-relaxed text-ink-soft", ring[tone])} role="status">
      {title && <p className="mb-0.5 font-semibold text-ink">{title}</p>}
      {children}
    </div>
  );
}
