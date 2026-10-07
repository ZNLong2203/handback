import "server-only";
import { getDb } from "@/lib/db/client";
import { recordDispute, type DisputeLike } from "@/lib/disputes/record";
import { rentalIdForDispute } from "@/lib/disputes/repo";
import { publish } from "@/lib/live";
import { fromPayPalValue } from "@/lib/money";
import { appendEvent } from "./audit";
import { refundCaptureAfterCancel } from "./cancel";
import { recordRefundWebhook, refundedCaptureId, rentalIdForRefund, type RefundResource } from "./refunds";
import { rentalByAuthorization, rentalById, rentalByOrder, updateRental } from "./repo";
import { confirmBooking } from "./service";
import { PayPalStepError, UserError, type Rental } from "./types";

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  summary?: string;
  resource?: Record<string, unknown> & {
    id?: string;
    status?: string;
    intent?: string;
    dispute_id?: string;
    reason?: string;
    disputed_transactions?: { seller_transaction_id?: string }[];
    supplementary_data?: { related_ids?: { authorization_id?: string; order_id?: string } };
    amount?: { value?: string; currency_code?: string };
    invoice_id?: string;
    note_to_payer?: string;
    links?: { href?: string; rel?: string }[];
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
 * PAYMENT.CAPTURE.REFUNDED carries the refund, not the capture: it is matched
 * on the refund id first, so a refund the counter made is counted once, then
 * on the capture its `up` link names (see refunds.ts).
 *
 * CHECKOUT.ORDER.APPROVED carries the order the renter approved, for a renter
 * who approved and closed the window before PayPal sent them back. Its
 * resource has no capture and no saved-wallet token, so it does not book the
 * rental itself: for a rental still unpaid whose booking order is this order,
 * it runs confirmBooking, the capture the page and the redirect run, with the
 * same PayPal-Request-Id (booking-capture:<rental id>), so whichever arrives
 * first captures and the others change nothing.
 */
export async function applyPayPalWebhook(event: PayPalWebhookEvent): Promise<"duplicate" | "applied" | "ignored"> {
  const db = await getDb();
  const resourceId = event.resource?.id ?? event.resource?.dispute_id ?? null;
  const inserted = await db.query<{ id: string }>(
    "insert into webhook_events (id, event_type, resource_id, verified, payload) values ($1, $2, $3, true, $4::jsonb) on conflict (id) do nothing returning id",
    [event.id, event.event_type, resourceId, JSON.stringify(event)],
  );
  if (inserted.length === 0) return "duplicate";
  try {
    return await apply(event, resourceId);
  } catch (err) {
    // The delivery failed (the route answers 500), so PayPal sends the event
    // again; free its id so that delivery is applied, not called a duplicate.
    await db.query("delete from webhook_events where id = $1", [event.id]);
    throw err;
  }
}

async function apply(event: PayPalWebhookEvent, resourceId: string | null): Promise<"applied" | "ignored"> {
  const db = await getDb();
  const r = event.resource ?? {};
  let rental: Rental | null = null;
  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" && r.id) {
    const known = await rentalIdForRefund(db, r.id);
    const captureId = refundedCaptureId(r as RefundResource);
    rental = known ? await rentalById(db, known) : captureId ? await rentalByCapture(captureId) : null;
  } else if (event.event_type.startsWith("PAYMENT.CAPTURE.") && r.id) {
    rental = await rentalByCapture(r.id);
    if (!rental && r.supplementary_data?.related_ids?.authorization_id) {
      rental = await rentalByAuthorization(db, r.supplementary_data.related_ids.authorization_id);
    }
  } else if (event.event_type.startsWith("PAYMENT.AUTHORIZATION.") && r.id) {
    rental = await rentalByAuthorization(db, r.id);
  } else if (event.event_type === "CHECKOUT.ORDER.APPROVED" && r.id) {
    rental = await rentalByOrder(db, r.id);
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
  const approvedUnpaid =
    event.event_type === "CHECKOUT.ORDER.APPROVED" &&
    rental.status === "draft" &&
    rental.feeCaptureId === null &&
    rental.bookingOrderId === r.id &&
    (r.intent ?? "CAPTURE") === "CAPTURE";
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
      } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
        moved = await recordRefundWebhook(tx, rental!, r as RefundResource, event.id);
      }
    }
  });
  publish(rentalId, moved ?? event.event_type);
  if (approvedUnpaid) await captureApproved(rentalId, r.id!, event.id);
  // A fee capture PayPal left PENDING after its unpaid booking was cancelled
  // (cancel.ts) has completed: refund it in full. Ignored for any other booking.
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && rental.status === "cancelled" && rental.cancelledAt && rental.feeCaptureId === r.id) {
    const cents = r.amount?.value ? fromPayPalValue(r.amount.value) : rental.feeCents;
    await refundCaptureAfterCancel(rentalId, { captureId: r.id, status: "COMPLETED", capturedCents: cents });
  }
  return "applied";
}

/**
 * Captures a booking the renter approved, from CHECKOUT.ORDER.APPROVED. A
 * refusal PayPal would repeat is already in the rental's audit log (paypalStep
 * wrote it) and the renter can approve again. A failure that may pass later
 * fails the delivery, so PayPal's redelivery tries again with the same
 * request id.
 */
async function captureApproved(rentalId: string, orderId: string, webhookEventId: string): Promise<void> {
  try {
    await confirmBooking(orderId);
  } catch (err) {
    if (!(err instanceof UserError) || (err instanceof PayPalStepError && err.retryable)) throw err;
    // PayPal's refusals are already in the log (paypalStep). One from before
    // PayPal, such as the last unit going while the renter was in PayPal, is not.
    if (!(err instanceof PayPalStepError)) {
      await appendEvent(await getDb(), rentalId, "system", "booking.not_captured", { orderId, reason: err.message, webhookEventId });
      publish(rentalId, "booking.not_captured");
    }
  }
}
