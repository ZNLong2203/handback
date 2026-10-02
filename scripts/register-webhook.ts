/**
 * Registers this deployment's webhook URL with the PayPal sandbox app and
 * prints the webhook id to put in PAYPAL_WEBHOOK_ID. PayPal only delivers to
 * public HTTPS on port 443, so run it against the deployed URL.
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/register-webhook.ts https://your-app.onrender.com
 */
import { paypalRest } from "@/lib/paypal/rest";

const base = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("Pass the public https URL of the deployment");
const url = `${base}/api/paypal/webhooks`;

const EVENTS = [
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

type Webhook = { id: string; url: string };
const { webhooks } = await paypalRest<{ webhooks: Webhook[] }>("GET", "/v1/notifications/webhooks");
const existing = webhooks.find((w) => w.url === url);
if (existing) {
  console.log(`Already registered: PAYPAL_WEBHOOK_ID=${existing.id}`);
} else {
  const created = await paypalRest<Webhook>("POST", "/v1/notifications/webhooks", {
    body: { url, event_types: EVENTS.map((name) => ({ name })) },
  });
  console.log(`Registered ${url}\nPAYPAL_WEBHOOK_ID=${created.id}`);
}
