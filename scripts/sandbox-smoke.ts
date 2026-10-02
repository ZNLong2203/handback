// Exercises the real PayPalDepositGateway against the sandbox. The hold is
// placed with a sandbox test card so no buyer has to click through PayPal;
// everything after that goes through the same code the app uses.
// Run: npm run smoke:sandbox
import { randomUUID } from "node:crypto";
import { PayPalDepositGateway } from "@/lib/paypal/paypal-gateway";
import { PayPalError } from "@/lib/paypal/errors";
import { paypalConfig } from "@/lib/paypal/config";

const cfg = paypalConfig();
if (cfg.mode === "demo") throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local first");

async function cardHold(totalUsd: string): Promise<string> {
  const token = await fetch(`${cfg.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
    body: "grant_type=client_credentials",
  }).then((r) => r.json() as Promise<{ access_token: string }>);
  const order = await fetch(`${cfg.apiBase}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
    body: JSON.stringify({
      intent: "AUTHORIZE",
      purchase_units: [{ amount: { currency_code: "USD", value: totalUsd } }],
      payment_source: { card: { number: "4032039317984658", expiry: "2030-01", security_code: "123", name: "Smoke Test" } },
    }),
  }).then((r) => r.json() as Promise<{ purchase_units: { payments: { authorizations: { id: string }[] } }[] }>);
  return order.purchase_units[0].payments.authorizations[0].id;
}

const gw = new PayPalDepositGateway(cfg.mode);
const step = (label: string, value: unknown) => console.log(label.padEnd(28), JSON.stringify(value));

const authId = await cardHold("380.00");
step("hold placed (card)", authId);
step("getAuthorization", await gw.getAuthorization(authId));
const settleId = `settle-${randomUUID()}`;
const settled = await gw.settle({ authorizationId: authId, amountCents: 12500, authorizedCents: 38000, invoiceId: `smoke-${Date.now()}`, noteToPayer: "Rental fee + lens scratch" }, settleId);
step("settle $125 of $380", settled);
const again = await gw.settle({ authorizationId: authId, amountCents: 12500, authorizedCents: 38000, invoiceId: "ignored", noteToPayer: "" }, settleId);
step("same request id again", { sameCapture: again.captureId === settled.captureId });
step("refund $20", await gw.refund({ captureId: settled.captureId, amountCents: 2000, noteToPayer: "Goodwill credit" }, `refund-${randomUUID()}`));

const voidId = await cardHold("200.00");
await gw.release(voidId, `void-${randomUUID()}`);
step("release (void) other hold", (await gw.getAuthorization(voidId)).status);

try {
  await gw.reauthorize(voidId, 20000, `reauth-${randomUUID()}`);
} catch (err) {
  const e = err as PayPalError;
  step("reauthorize voided hold", { status: e.status, issue: e.issue, debugId: e.debugId });
}
