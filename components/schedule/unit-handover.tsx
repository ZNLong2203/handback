import { PackageCheck } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/ui";
import type { Rental } from "@/lib/rentals/types";
import { handovers } from "@/lib/schedule/handover";

/** At pickup: which unit to give the customer, and a warning when that unit is not ready to go out. */
export async function UnitHandover({ rental }: { rental: Rental }) {
  const handover = (await handovers([rental])).get(rental.id);
  if (!handover) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-paper px-4 py-3" data-testid="handover">
        <p className="flex items-center gap-2">
          <PackageCheck className="h-5 w-5 shrink-0 text-brand" aria-hidden />
          <span>
            <span className="text-muted">Hand over </span>
            <span className="font-display text-lg font-bold">{handover.label}</span>
          </span>
        </p>
        <Link href="/shop/schedule" className="text-sm font-medium text-brand hover:underline">
          See the schedule
        </Link>
      </div>
      {handover.warning && (
        <Notice tone="charged" title={`Check before handing over ${handover.label}`}>
          {handover.warning}
        </Notice>
      )}
    </div>
  );
}
