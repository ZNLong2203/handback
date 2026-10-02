import Link from "next/link";
import { cx } from "./ui";

/** A hand-off loop: an arrow leaving and coming back. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cx("h-8 w-8", className)}>
      <rect width="32" height="32" rx="10" className="fill-ink" />
      <path d="M9 13.5a7 7 0 0 1 12.6-4.2" fill="none" stroke="#fcf3e2" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M22.4 6.6v3.6h-3.6" fill="none" stroke="#fcf3e2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23 18.5a7 7 0 0 1-12.6 4.2" fill="none" stroke="#7fd0a6" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M9.6 25.4v-3.6h3.6" fill="none" stroke="#7fd0a6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ href = "/", suffix }: { href?: string; suffix?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5" aria-label="Handback home">
      <LogoMark />
      <span className="font-display text-xl font-bold tracking-tight">Handback</span>
      {suffix && <span className="rounded-full bg-line/70 px-2 py-0.5 text-xs font-semibold text-ink-soft">{suffix}</span>}
    </Link>
  );
}
