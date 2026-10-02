import "server-only";
import type { Db } from "@/lib/db/client";
import { usdCents, type Dispute } from "@/lib/paypal/dispute-model";
import { appendEvent } from "@/lib/rentals/audit";
import { rentalById, updateRental } from "@/lib/rentals/repo";
import type { RentalStatus } from "@/lib/rentals/types";
import { disputeById, saveDispute } from "./repo";

type Query = Pick<Db, "query">;

/** A dispute as PayPal described it: a full GET, or a webhook resource that may leave fields out. */
export type DisputeLike = Partial<Dispute> & { dispute_id: string };

export type RecordResult = "opened" | "updated" | "resolved" | "unchanged" | "stale";

/**
 * A settled rental shows as disputed while PayPal has an open case, and as
 * settled again once PayPal closes it. A dispute on a rental that is still
 * running is recorded without changing where the rental is.
 */
export function rentalStatusFor(current: RentalStatus, disputeStatus: string): RentalStatus {
  if (disputeStatus === "RESOLVED") return current === "disputed" ? "settled" : current;
  return current === "settled" ? "disputed" : current;
}

/**
 * Stores PayPal's latest view of a dispute and writes what changed into the
 * rental's audit trail: opened, a new status or stage, resolved. A view
 * older than the stored one (webhooks can arrive out of order) is ignored.
 */
export async function recordDispute(
  tx: Query,
  rentalId: string,
  incoming: DisputeLike,
  via: "paypal" | "webhook" | "demo",
  webhookEventId: string | null = null,
): Promise<RecordResult> {
  const rental = await rentalById(tx, rentalId);
  if (!rental) throw new Error(`no rental ${rentalId}`);
  const existing = await disputeById(tx, incoming.dispute_id);
  if (existing?.paypalUpdateTime && incoming.update_time && Date.parse(incoming.update_time) < Date.parse(existing.paypalUpdateTime)) return "stale";

  const d: DisputeLike = existing ? { ...existing.paypal, ...incoming } : incoming;
  const status = d.status ?? "OPEN";
  const stage = d.dispute_life_cycle_stage ?? null;
  const row = {
    id: d.dispute_id,
    rentalId,
    transactionId: d.disputed_transactions?.[0]?.seller_transaction_id ?? existing?.transactionId ?? null,
    reason: d.reason ?? existing?.reason ?? "OTHER",
    status,
    stage,
    amountCents: usdCents(d.dispute_amount),
    sellerResponseDueAt: status === "RESOLVED" ? null : (d.seller_response_due_date ?? null),
    outcome: d.dispute_outcome?.outcome_code ?? null,
    refundedCents: usdCents(d.dispute_outcome?.amount_refunded),
    paypal: d,
    paypalUpdateTime: d.update_time ?? existing?.paypalUpdateTime ?? null,
    openedAt: d.create_time ?? existing?.openedAt ?? null,
  };
  await saveDispute(tx, row);

  const next = rentalStatusFor(rental.status, status);
  const fields = { ...(rental.disputeId !== row.id ? { dispute_id: row.id } : {}), ...(next !== rental.status ? { status: next } : {}) };
  if (Object.keys(fields).length) await updateRental(tx, rentalId, fields);

  const base = { disputeId: row.id, status, stage, via, ...(webhookEventId ? { webhookEventId } : {}) };
  const resolved = { ...base, outcome: row.outcome, refundedCents: row.refundedCents };
  if (!existing) {
    await appendEvent(tx, rentalId, "paypal", "dispute.opened", { ...base, reason: row.reason, amountCents: row.amountCents, transactionId: row.transactionId });
    if (status === "RESOLVED") await appendEvent(tx, rentalId, "paypal", "dispute.resolved", resolved);
    return status === "RESOLVED" ? "resolved" : "opened";
  }
  if (status === "RESOLVED" && existing.status !== "RESOLVED") {
    await appendEvent(tx, rentalId, "paypal", "dispute.resolved", resolved);
    return "resolved";
  }
  if (status !== existing.status || stage !== existing.stage) {
    await appendEvent(tx, rentalId, "paypal", "dispute.updated", { ...base, dueAt: row.sellerResponseDueAt });
    return "updated";
  }
  return "unchanged";
}
