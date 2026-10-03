import { paypalConfig } from "@/lib/paypal/config";
import { webhookHeaders } from "@/lib/paypal/webhook-signature";
import { verifyWebhook } from "@/lib/paypal/webhooks";
import { applyPayPalWebhook, type PayPalWebhookEvent } from "@/lib/rentals/webhooks";

export const dynamic = "force-dynamic";

/** PayPal webhook receiver: verify, deduplicate on event id, apply, answer 200 fast. */
export async function POST(req: Request) {
  const { webhookId } = paypalConfig();
  if (!webhookId) return Response.json({ error: "PAYPAL_WEBHOOK_ID is not set" }, { status: 503 });
  const headers = webhookHeaders(req.headers);
  if (!headers) return Response.json({ error: "missing PayPal transmission headers" }, { status: 400 });

  const raw = new Uint8Array(await req.arrayBuffer());
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(Buffer.from(raw).toString("utf8")) as PayPalWebhookEvent;
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  if (!event.id || !event.event_type) return Response.json({ error: "not a PayPal event" }, { status: 400 });

  if (!(await verifyWebhook(headers, webhookId, raw, event))) {
    console.warn(`rejected unverified webhook ${event.id} (${event.event_type})`);
    return Response.json({ error: "signature verification failed" }, { status: 401 });
  }
  try {
    const result = await applyPayPalWebhook(event);
    return Response.json({ ok: true, result });
  } catch (err) {
    // Not a 2xx, so PayPal delivers the event again later.
    console.error(`webhook ${event.id} (${event.event_type}) failed`, err);
    return Response.json({ error: "could not apply the event; PayPal will retry" }, { status: 500 });
  }
}
