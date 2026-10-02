import "server-only";
import { getDb } from "@/lib/db/client";
import { recordDispute, type DisputeLike } from "@/lib/disputes/record";
import { rentalIdForDispute } from "@/lib/disputes/repo";
import { publish } from "@/lib/live";
import { appendEvent } from "./audit";
import { rentalByAuthorization, rentalById, updateRental } from "./repo";
import type { Rental } from "./types";

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  summary?: string;
  resource?: Record<string, unknown> & {
    id?: string;
    status?: string;
    dispute_id?: string;
    reason?: string;
    disputed_transactions?: { seller_transaction_id?: string }[];
    supplementary_data?: { related_ids?: { authorization_id?: string; order_id?: string } };
  };
};

async function rentalByCapture(captureId: string): Promise<Rental | null> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "select id from rentals where fee_capture_id = $1 or settlement_capture_id = $1 or extra_capture_id = $1",
    [captureId],
  );
  return rows[0] ? rentalById(db, rows[0].id) : null;
}

/**
 * Applies one verified PayPal webhook. Deliveries are deduplicated on the
 * event id (PayPal retries for up to three days), and every event that
 * touches a rental lands in that rental's audit trail. A booking whose fee
 * capture PayPal left PENDING is booked when that capture completes, and
 * cancelled when PayPal denies it. Dispute events (CUSTOMER.DISPUTE.CREATED,
 * UPDATED, RESOLVED) carry the dispute itself; they update the stored dispute
 * and the rental, and a delivery older than what is stored changes nothing.
 */
export async function applyPayPalWebhook(event: PayPalWebhookEvent): Promise<"duplicate" | "applied" | "ignored"> {
  const db = await getDb();
  const resourceId = event.resource?.id ?? event.resource?.dispute_id ?? null;
  const inserted = await db.query<{ id: string }>(
    "insert into webhook_events (id, event_type, resource_id, verified, payload) values ($1, $2, $3, true, $4::jsonb) on conflict (id) do nothing returning id",
    [event.id, event.event_type, resourceId, JSON.stringify(event)],
  );
  if (inserted.length === 0) return "duplicate";

  const r = event.resource ?? {};
  let rental: Rental | null = null;
  if (event.event_type.startsWith("PAYMENT.CAPTURE.") && r.id) {
    rental = await rentalByCapture(r.id);
    if (!rental && r.supplementary_data?.related_ids?.authorization_id) {
      rental = await rentalByAuthorization(db, r.supplementary_data.related_ids.authorization_id);
    }
  } else if (event.event_type.startsWith("PAYMENT.AUTHORIZATION.") && r.id) {
    rental = await rentalByAuthorization(db, r.id);
  } else if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
    const known = r.dispute_id ? await rentalIdForDispute(db, r.dispute_id) : null;
    if (known) rental = await rentalById(db, known);
    const captureId = r.disputed_transactions?.[0]?.seller_transaction_id;
    if (!rental && captureId) rental = await rentalByCapture(captureId);
  }
  if (!rental) return "ignored";

  // Only a fee capture that confirmBooking recorded as pending. Matching on the
  // order id instead could let an early webhook book the rental before
  // confirmBooking has stored the saved-wallet token.
  const pendingFee = rental.status === "draft" && rental.feeCaptureId !== null && rental.feeCaptureId === r.id;
  let moved: string | null = null;
  const rentalId = rental.id;
  await db.tx(async (tx) => {
    const recorded = event.event_type.startsWith("CUSTOMER.DISPUTE.") && r.dispute_id ? await recordDispute(tx, rentalId, r as DisputeLike, "webhook", event.id) : null;
    if (recorded === null || recorded === "unchanged" || recorded === "stale") {
      await appendEvent(tx, rentalId, "paypal", "webhook.received", {
        eventType: event.event_type,
        resourceId,
        status: r.status ?? null,
        webhookEventId: event.id,
      });
      if (pendingFee && event.event_type === "PAYMENT.CAPTURE.COMPLETED" && (await updateRental(tx, rentalId, { status: "booked" }, "draft"))) {
        await appendEvent(tx, rentalId, "paypal", "booking.paid", { captureId: r.id, feeCents: rental!.feeCents, savedWallet: Boolean(rental!.vaultId) });
        moved = "booking.paid";
      } else if (pendingFee && event.event_type === "PAYMENT.CAPTURE.DENIED" && (await updateRental(tx, rentalId, { status: "cancelled" }, "draft"))) {
        await appendEvent(tx, rentalId, "paypal", "booking.declined", { captureId: r.id, status: "DENIED" });
        moved = "booking.declined";
      }
    }
  });
  publish(rentalId, moved ?? event.event_type);
  return "applied";
}
