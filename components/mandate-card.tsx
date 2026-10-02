import { FileCheck2, ShieldX } from "lucide-react";
import { shortDate } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import { mandateTerms, type DepositMandate } from "@/lib/rentals/mandate";
import { Card } from "./ui";

function issuedToLine(m: DepositMandate): string {
  const when = new Date(m.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  if (m.issuedTo.party === "renter") return `Issued to you when you booked, ${when} UTC.`;
  const name = m.issuedTo.assistant ? ` (it calls itself ${m.issuedTo.assistant})` : "";
  return `Issued to the assistant that booked for you${name}, ${when} UTC. Your approval in PayPal is what puts it into effect.`;
}

/**
 * The deposit mandate on the renter's page: the terms in plain sentences, the
 * price list it froze, and the exact JSON with its SHA-256 for anyone who
 * wants to check it. Before payment it is open; afterwards it folds away.
 */
export function MandateCard({ mandate, json, sha256, intact, folded }: { mandate: DepositMandate; json: string; sha256: string; intact: boolean; folded?: boolean }) {
  const body = (
    <>
      {!intact && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-charged-soft px-3 py-2 text-sm text-charged">
          <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> The stored mandate no longer matches its hash, so the shop cannot hold or charge anything under it.
        </p>
      )}
      <ul className="mt-4 space-y-2 text-sm leading-relaxed text-ink-soft">
        {mandateTerms(mandate).map((t) => (
          <li key={t} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
      <table className="mt-4 w-full text-sm">
        <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-[0.14em] text-muted">Price list, as of booking</caption>
        <tbody>
          {mandate.priceList.map((p) => (
            <tr key={p.id} className="border-t border-line">
              <td className="py-1.5 pr-3">{p.label}</td>
              <td className="tabular py-1.5 text-right font-semibold">{formatUsd(p.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted">{issuedToLine(mandate)}</p>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium text-ink-soft">The exact terms, as stored and hashed</summary>
        <p className="mt-2 break-all font-mono text-[11px] text-muted">sha256 {sha256}</p>
        <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-paper p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
          {JSON.stringify(JSON.parse(json), null, 2)}
        </pre>
      </details>
    </>
  );

  if (folded) {
    return (
      <details className="rounded-[var(--radius-card)] border border-line bg-card p-5">
        <summary className="cursor-pointer font-semibold">
          Your deposit mandate <span className="font-normal text-muted">· up to {formatUsd(mandate.hold.maxCents)} · ends {shortDate(mandate.expiresAt)}</span>
        </summary>
        {body}
      </details>
    );
  }
  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold">
        <FileCheck2 className="h-5 w-5 text-brand" aria-hidden /> What you allow the shop to do
      </h2>
      <p className="mt-1 text-sm text-muted">This deposit mandate is fixed when the booking starts. Approving in PayPal is how you agree to it.</p>
      {body}
    </Card>
  );
}
