import { formatUsd } from "@/lib/money";
import { cx } from "./ui";

type Props =
  | { state: "none"; depositCents: number }
  | { state: "held"; authorizedCents: number }
  | { state: "proposed"; authorizedCents: number; proposedCents: number }
  | { state: "settled"; authorizedCents: number; capturedCents: number; releasedCents: number; extraCents?: number; refundedCents?: number; voided?: boolean };

const pct = (part: number, whole: number) => (whole <= 0 ? 0 : Math.max(0, Math.min(100, (part / whole) * 100)));

/**
 * The deposit as one bar. While PayPal holds it the bar is amber; a proposal
 * shows the part that would be kept; after settlement the bar splits into
 * what the shop kept (coral) and what went back to the customer (green).
 */
export function MoneyBar(props: Props & { className?: string; size?: "md" | "lg" }) {
  const h = props.size === "lg" ? "h-5" : "h-3";
  if (props.state === "none") {
    return (
      <div className={props.className}>
        <div className={cx(h, "w-full rounded-full border-2 border-dashed border-line-strong")} />
        <p className="mt-2 text-sm text-muted">
          <span className="tabular font-semibold text-ink">{formatUsd(props.depositCents)}</span> deposit, held at pickup. Not charged.
        </p>
      </div>
    );
  }
  if (props.state === "held") {
    return (
      <div className={props.className}>
        <div className={cx(h, "w-full overflow-hidden rounded-full bg-held-soft")}>
          <div className="h-full w-full origin-left animate-[grow_0.9s_cubic-bezier(0.2,0.8,0.2,1)_both] rounded-full bg-held" />
        </div>
        <p className="mt-2 text-sm text-muted">
          <span className="tabular font-semibold text-held">{formatUsd(props.authorizedCents)}</span> held on PayPal. Nothing has been charged.
        </p>
      </div>
    );
  }
  if (props.state === "proposed") {
    const p = pct(props.proposedCents, props.authorizedCents);
    return (
      <div className={props.className}>
        <div className={cx(h, "relative w-full overflow-hidden rounded-full bg-held")}>
          <div
            className="absolute inset-y-0 left-0 origin-left animate-[grow_0.9s_cubic-bezier(0.2,0.8,0.2,1)_both] bg-[repeating-linear-gradient(135deg,var(--color-charged)_0_8px,color-mix(in_oklab,var(--color-charged)_75%,white)_8px_16px)]"
            style={{ width: `${p}%` }}
          />
        </div>
        <p className="mt-2 text-sm text-muted">
          Proposed: keep <span className="tabular font-semibold text-charged">{formatUsd(props.proposedCents)}</span> of the{" "}
          <span className="tabular font-semibold text-held">{formatUsd(props.authorizedCents)}</span> hold. Nothing moves until the customer has seen it.
        </p>
      </div>
    );
  }
  const kept = pct(props.capturedCents, props.authorizedCents);
  return (
    <div className={props.className}>
      <div className={cx(h, "flex w-full gap-1 overflow-hidden rounded-full")}>
        {props.capturedCents > 0 && (
          <div className="h-full origin-left animate-[grow_0.9s_cubic-bezier(0.2,0.8,0.2,1)_both] rounded-full bg-charged" style={{ width: `${kept}%` }} />
        )}
        {props.releasedCents > 0 && (
          <div className="h-full flex-1 origin-right animate-[grow_1.1s_cubic-bezier(0.2,0.8,0.2,1)_0.15s_both] rounded-full bg-released" />
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span className="text-muted">
          Kept <span className="tabular font-semibold text-charged">{formatUsd(props.capturedCents)}</span>
        </span>
        <span className="text-muted">
          Released <span className="tabular font-semibold text-released">{formatUsd(props.releasedCents)}</span> on PayPal
        </span>
        {Boolean(props.extraCents) && (
          <span className="text-muted">
            Plus <span className="tabular font-semibold text-charged">{formatUsd(props.extraCents!)}</span> above the deposit
          </span>
        )}
        {Boolean(props.refundedCents) && (
          <span className="text-muted">
            Refunded <span className="tabular font-semibold text-released">{formatUsd(props.refundedCents!)}</span> afterwards
          </span>
        )}
      </div>
    </div>
  );
}
