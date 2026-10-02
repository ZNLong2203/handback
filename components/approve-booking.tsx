import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatUsd } from "@/lib/money";
import type { Rental } from "@/lib/rentals/types";
import { ButtonAnchor, Card } from "./ui";

/**
 * An unpaid booking's way back to PayPal: what approving does, and PayPal's
 * approval link. A plain anchor, so the framework never prefetches it.
 * `children` carries a notice about the last attempt, if any.
 */
export function ApproveBooking({
  rental,
  item,
  byAssistant,
  children,
}: {
  rental: Pick<Rental, "feeCents" | "depositCents" | "approveUrl">;
  item: { id: string; name: string };
  byAssistant: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className="p-6">
      <h2 className="font-semibold">Approve the booking in PayPal</h2>
      {children && <div className="mt-3">{children}</div>}
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {byAssistant ? "Your assistant started this booking for you, but only you can pay for it. " : ""}
        In PayPal you pay the {formatUsd(rental.feeCents)} rental fee and let PayPal save your account, so the shop can hold the{" "}
        {formatUsd(rental.depositCents)} deposit at pickup on the terms below. Nothing is paid until you approve.
      </p>
      {rental.approveUrl ? (
        <ButtonAnchor href={rental.approveUrl} variant="brand" size="lg" className="mt-4">
          Review and pay {formatUsd(rental.feeCents)} in PayPal <ExternalLink className="h-4 w-4" aria-hidden />
        </ButtonAnchor>
      ) : (
        <p className="mt-3 text-sm">
          This booking has no PayPal approval link.{" "}
          <Link href={`/rent/${item.id}`} className="font-semibold underline underline-offset-2">
            Book the {item.name.toLowerCase()} again
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
