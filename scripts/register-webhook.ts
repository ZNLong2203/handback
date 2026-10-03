/**
 * Registers this deployment's webhook URL with the PayPal sandbox app and
 * prints the webhook id to put in PAYPAL_WEBHOOK_ID. If the URL is already
 * registered, it adds any event type below that the registration lacks
 * (PATCH, `replace` on /event_types, keeping the ones it has). PayPal only
 * delivers to public HTTPS on port 443, so run it against the deployed URL.
 *   npm run paypal:webhook -- https://your-app.onrender.com
 * From the Render Shell of the web service the URL can be left out.
 */
import { paypalRest } from "@/lib/paypal/rest";

const base = (process.argv[2] || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("Pass the public https URL of the deployment");
const url = `${base}/api/paypal/webhooks`;

const EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "VAULT.PAYMENT-TOKEN.CREATED",
  "VAULT.PAYMENT-TOKEN.DELETED",
];

type Webhook = { id: string; url: string; event_types?: { name: string }[] };
const { webhooks } = await paypalRest<{ webhooks: Webhook[] }>("GET", "/v1/notifications/webhooks");
const existing = webhooks.find((w) => w.url === url);
if (existing) {
  const has = (existing.event_types ?? []).map((e) => e.name);
  const missing = EVENTS.filter((name) => !has.includes(name));
  if (missing.length > 0) {
    const updated = await paypalRest<Webhook>("PATCH", `/v1/notifications/webhooks/${existing.id}`, {
      body: [{ op: "replace", path: "/event_types", value: [...has, ...missing].map((name) => ({ name })) }],
    });
    console.log(`Added ${missing.join(", ")}; it now has ${(updated.event_types ?? []).length} event types.`);
  }
  console.log(`Already registered: PAYPAL_WEBHOOK_ID=${existing.id}`);
} else {
  const created = await paypalRest<Webhook>("POST", "/v1/notifications/webhooks", {
    body: { url, event_types: EVENTS.map((name) => ({ name })) },
  });
  console.log(`Registered ${url}\nPAYPAL_WEBHOOK_ID=${created.id}`);
}
