/**
 * Drives the real app against the PayPal sandbox and live Gemini: the JS SDK
 * v6 button, the sandbox buyer's popup approval, the saved-wallet deposit
 * hold, the two-look comparison and the final capture. Needs the dev server
 * running with sandbox credentials (npm run dev) and the sandbox buyer login
 * in .env.local.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/sandbox-walkthrough.ts [--headed]
 */
import { chromium, type Page } from "@playwright/test";

const BASE = process.env.WALKTHROUGH_URL ?? "http://localhost:3000";
const OUT = process.env.WALKTHROUGH_SHOTS;
const buyer = { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "", password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? "" };
if (!buyer.email || !buyer.password) throw new Error("Set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD");

const shot = async (page: Page, name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};
const step = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

async function approveInPopup(popup: Page) {
  await popup.waitForLoadState("domcontentloaded");
  const email = popup.locator('input#email, input[name="login_email"]');
  await email.first().waitFor({ timeout: 60_000 });
  await email.first().fill(buyer.email);
  const next = popup.locator("#btnNext");
  if (await next.isVisible().catch(() => false)) await next.click();
  await popup.locator('input#password, input[name="login_password"]').first().waitFor({ timeout: 30_000 });
  await popup.locator('input#password, input[name="login_password"]').first().fill(buyer.password);
  await popup.locator("#btnLogin").click();
  for (let i = 0; i < 20 && !popup.isClosed(); i++) {
    const button = popup.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      step(`  popup: clicking "${(await button.innerText().catch(() => "?")).trim().slice(0, 40)}"`);
      await button.click().catch(() => {});
    }
    await popup.waitForTimeout(2000).catch(() => {});
  }
}

const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") step(`  browser error: ${m.text().slice(0, 200)}`);
});

try {
  step("booking page");
  await page.goto(`${BASE}/rent/camera-kit`);
  await page.getByLabel("Your name").fill("Maya Chen");
  await page.getByLabel("Email").fill("maya@example.com");
  const button = page.locator("paypal-button");
  await button.waitFor({ timeout: 60_000 });
  await shot(page, "s01-booking");
  step("clicking the PayPal button");
  const popupPromise = page.waitForEvent("popup", { timeout: 60_000 });
  await button.click();
  const popup = await popupPromise;
  await approveInPopup(popup);
  await page.waitForURL(/\/r\//, { timeout: 90_000 });
  step(`booked: ${page.url()}`);
  await page.getByText(/Paid \$87\.00 with PayPal/).waitFor();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await page.getByText(/^Rental R-/).textContent()) ?? "")![0];
  await shot(page, "s02-customer-booked");

  const counter = await context.newPage();
  await counter.goto(`${BASE}/shop/rentals/${rentalId}`);
  step("pickup photo + hold deposit on the saved wallet");
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await counter.getByRole("button", { name: "Hold $300.00 deposit" }).click();
  await counter.getByRole("heading", { name: "Return" }).waitFor({ timeout: 60_000 });
  await shot(counter, "s03-counter-out");

  step("customer confirms the pickup photo");
  await page.getByRole("button", { name: "Yes, this is how I received it" }).click();
  await page.getByText(/You confirmed this photo/).waitFor();

  step("return photo: hood missing; two live Gemini looks");
  await counter.getByRole("button", { name: /Hood removed/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await counter.getByRole("heading", { name: "What the photos show" }).waitFor({ timeout: 120_000 });
  await shot(counter, "s04-counter-findings");
  const send = counter.getByRole("button", { name: /Send \d item/ });
  if (await send.isVisible().catch(() => false)) {
    await send.click();
    await page.getByRole("heading", { name: "Please review what the shop found" }).waitFor({ timeout: 30_000 });
    for (const fair of await page.getByRole("button", { name: "That's fair" }).all()) await fair.click();
    await page.getByRole("button", { name: "Send my answers" }).click();
    await page.getByText("Thanks. The shop is reading your answers.").waitFor({ timeout: 30_000 });
    step("customer accepted; settling");
    await counter.getByRole("button", { name: /^Keep \$/ }).click();
  } else {
    step("nothing to charge; releasing");
    await counter.getByRole("button", { name: /Release the whole/ }).click();
  }
  await counter.getByRole("heading", { name: "Settled" }).waitFor({ timeout: 60_000 });
  await counter.waitForTimeout(1500);
  await shot(counter, "s05-counter-settled");
  const ids = await counter.locator("dl.font-mono").innerText();
  step(`settled on PayPal sandbox: ${ids.replace(/\s+/g, " ")}`);
  await page.waitForTimeout(1500);
  await shot(page, "s06-customer-receipt");
} finally {
  await browser.close();
}
