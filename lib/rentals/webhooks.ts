import "server-only";
import { getDb } from "@/lib/db/client";
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
 * touches a rental lands in that rental's audit trail.
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
    const captureId = r.disputed_transactions?.[0]?.seller_transaction_id;
    if (captureId) rental = await rentalByCapture(captureId);
  }
  if (!rental) return "ignored";

  await db.tx(async (tx) => {
    if (event.event_type === "CUSTOMER.DISPUTE.CREATED") {
      await updateRental(tx, rental!.id, { status: "disputed", dispute_id: r.dispute_id ?? null });
      await appendEvent(tx, rental!.id, "paypal", "dispute.opened", { disputeId: r.dispute_id ?? null, reason: r.reason ?? null, webhookEventId: event.id });
    } else {
      await appendEvent(tx, rental!.id, "paypal", "webhook.received", {
        eventType: event.event_type,
        resourceId,
        status: r.status ?? null,
        webhookEventId: event.id,
      });
    }
  });
  publish(rental.id, event.event_type);
  return "applied";
}
