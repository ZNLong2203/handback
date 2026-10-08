// Places a few sandbox authorizations now so that reauthorization (allowed
// only from day 4) and late captures can be tested against real aged holds.
// Writes the ids to .data/sandbox/aged-holds.json (git ignores .data/). Run: npm run seed:aged-holds
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paypalConfig } from "@/lib/paypal/config";

const cfg = paypalConfig();
if (cfg.mode === "demo") throw new Error("Set PayPal sandbox credentials in .env.local first");

const token = await fetch(`${cfg.apiBase}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
  body: "grant_type=client_credentials",
}).then((r) => r.json() as Promise<{ access_token: string }>);

const card = { number: "4032039317984658", expiry: "2030-01", security_code: "123", name: "Aged Hold" };
const file = ".data/sandbox/aged-holds.json";
mkdirSync(".data/sandbox", { recursive: true });
const holds: unknown[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];

for (const [purpose, value] of [
  ["reauthorize on day 4, then capture the child", "300.00"],
  ["capture on day 5 without reauthorizing", "300.00"],
  ["void after day 4", "150.00"],
] as const) {
  const res = await fetch(`${cfg.apiBase}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
    body: JSON.stringify({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: "USD", value } }], payment_source: { card } }),
  });
  const order = (await res.json()) as { id: string; purchase_units: { payments: { authorizations: { id: string; create_time: string }[] } }[] };
  const auth = order.purchase_units[0].payments.authorizations[0];
  holds.push({ purpose, fundedBy: "card", orderId: order.id, authorizationId: auth.id, createdAt: auth.create_time, amount: value });
  console.log(purpose.padEnd(48), auth.id, auth.create_time);
}
writeFileSync(file, JSON.stringify(holds, null, 2));
