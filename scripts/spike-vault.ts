// Day-1 spike for the redesigned flow: pay the rental fee and save PayPal at
// booking, then hold the deposit later with the saved wallet (no buyer
// present), then settle. The sandbox buyer's approval is automated with
// Playwright. Run: npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/spike-vault.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { paypalConfig } from "@/lib/paypal/config";

const SHOTS = process.env.SPIKE_SHOTS ?? "/tmp";
const cfg = paypalConfig();
const buyer = { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "", password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? "" };
if (cfg.mode === "demo" || !buyer.email || !buyer.password) throw new Error("Need sandbox app credentials and buyer login in .env.local");

const token = (
  (await fetch(`${cfg.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
    body: "grant_type=client_credentials",
  }).then((r) => r.json())) as { access_token: string }
).access_token;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation", "PayPal-Request-Id": randomUUID() },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Spike script: the raw PayPal JSON is inspected ad hoc, not modelled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json().catch(() => ({}))) as any;
  const issue = json?.details?.[0]?.issue;
  console.log(`${method} ${path} -> ${res.status} ${json?.status ?? ""} ${json?.name ?? ""} ${issue ?? ""} debug_id=${res.headers.get("paypal-debug-id")}`);
  return json;
}

async function approveAsBuyer(page: Page, url: string, returnPrefix: string) {
  // Nothing listens on the return URL during a spike, so watch for the
  // browser's request to it instead of the page URL.
  let reached = false;
  page.on("request", (r) => {
    if (r.url().startsWith(returnPrefix)) reached = true;
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const shot = (n: string) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }).catch(() => {});
  await shot("01-landing");
  const email = page.locator('input#email, input[name="login_email"]');
  await email.first().waitFor({ timeout: 45_000 });
  await email.first().fill(buyer.email);
  const next = page.locator("#btnNext");
  if (await next.isVisible().catch(() => false)) await next.click();
  const password = page.locator('input#password, input[name="login_password"]');
  await password.first().waitFor({ timeout: 30_000 });
  await password.first().fill(buyer.password);
  await shot("02-password");
  await page.locator("#btnLogin").click();
  for (let i = 0; i < 12; i++) {
    if (reached) return;
    await page.waitForTimeout(2500);
    if (reached) return;
    await shot(`03-review-${i}`);
    const button = page.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      console.log("  clicking:", (await button.innerText().catch(() => "?")).trim().slice(0, 40));
      await button.click().catch(() => {});
    }
  }
  if (!reached) throw new Error(`buyer approval did not reach ${returnPrefix}; last url ${page.url()}`);
}

const RETURN = "http://localhost:3999/return";
// 1. Booking: pay the $80 fee and save PayPal for later charges.
const order = await api("POST", "/v2/checkout/orders", {
  intent: "CAPTURE",
  purchase_units: [{ reference_id: "bk_spike", custom_id: "bk_spike", description: "Rental fee, 3 days", amount: { currency_code: "USD", value: "80.00" } }],
  payment_source: {
    paypal: {
      attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER", description: "Kestrel Camera Rentals may hold a refundable deposit and charge approved damage" } },
      experience_context: { brand_name: "Kestrel Camera Rentals", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: RETURN, cancel_url: "http://localhost:3999/cancel" },
    },
  },
});
const approveUrl = (order.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "payer-action")?.href ?? "";
console.log("approve url:", approveUrl);

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
try {
  await approveAsBuyer(page, approveUrl, RETURN);
  console.log("  buyer approved");
} finally {
  await browser.close();
}

// 2. Capture the fee; the response carries the vault token.
const captured = await api("POST", `/v2/checkout/orders/${order.id}/capture`);
const vault = captured.payment_source?.paypal?.attributes?.vault;
console.log("vault:", JSON.stringify(vault));
if (!vault?.id) process.exit(1);

// 3. Pickup: hold the $300 deposit with the saved wallet, buyer not present.
const hold = await api("POST", "/v2/checkout/orders", {
  intent: "AUTHORIZE",
  purchase_units: [{ reference_id: "bk_spike", description: "Refundable damage deposit", amount: { currency_code: "USD", value: "300.00" } }],
  payment_source: { paypal: { vault_id: vault.id } },
});
const auth = hold.purchase_units?.[0]?.payments?.authorizations?.[0];
console.log("deposit hold:", hold.status, auth?.id, auth?.status, auth?.expiration_time);

// 4. Return: capture $45 of damage, final; the rest is released.
if (auth?.id) {
  const cap = await api("POST", `/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: "USD", value: "45.00" }, final_capture: true });
  console.log("settled:", cap.status, cap.amount?.value);
}

// 5. Damage above the deposit: charge the saved wallet directly.
const extra = await api("POST", "/v2/checkout/orders", {
  intent: "CAPTURE",
  purchase_units: [{ description: "Repair above deposit", amount: { currency_code: "USD", value: "60.00" } }],
  payment_source: { paypal: { vault_id: vault.id } },
});
console.log("overage charge:", extra.status, extra.purchase_units?.[0]?.payments?.captures?.[0]?.status);

// 6. Seed a wallet-funded hold for the day-4 reauthorization test.
const aged = await api("POST", "/v2/checkout/orders", {
  intent: "AUTHORIZE",
  purchase_units: [{ description: "Aged wallet hold", amount: { currency_code: "USD", value: "300.00" } }],
  payment_source: { paypal: { vault_id: vault.id } },
});
const agedAuth = aged.purchase_units?.[0]?.payments?.authorizations?.[0];
const file = ".data/sandbox/aged-holds.json";
mkdirSync(".data/sandbox", { recursive: true });
const holds = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
holds.push({ purpose: "reauthorize a PayPal-wallet hold on day 4", fundedBy: "paypal-vault", vaultId: vault.id, orderId: aged.id, authorizationId: agedAuth?.id, createdAt: agedAuth?.create_time, amount: "300.00" });
writeFileSync(file, JSON.stringify(holds, null, 2));
console.log("seeded wallet hold:", agedAuth?.id);
writeFileSync(".data/sandbox/spike-vault.json", JSON.stringify({ vaultId: vault.id, customer: vault.customer, at: new Date().toISOString() }, null, 2));
