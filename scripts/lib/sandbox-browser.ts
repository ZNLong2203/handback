/**
 * Browser steps shared by the sandbox scripts: signing in as the sandbox
 * buyer, approving a PayPal popup, and running the app's counter flow to a
 * settled rental. They drive the real app and PayPal's real pages, so they
 * need the dev server running with sandbox credentials.
 */
import type { BrowserContext, Page } from "@playwright/test";

export type Buyer = { email: string; password: string };

export function sandboxBuyer(): Buyer {
  const buyer = { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "", password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? "" };
  if (!buyer.email || !buyer.password) throw new Error("Set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD");
  return buyer;
}

export const step = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

/** Fills PayPal's two-step login form (email, then password) on whatever page shows it. */
export async function fillPayPalLogin(page: Page, buyer: Buyer) {
  const email = page.locator('input#email, input[name="login_email"]');
  await email.first().waitFor({ timeout: 60_000 });
  await email.first().fill(buyer.email);
  const next = page.locator("#btnNext");
  if (await next.isVisible().catch(() => false)) await next.click();
  await page.locator('input#password, input[name="login_password"]').first().waitFor({ timeout: 30_000 });
  await page.locator('input#password, input[name="login_password"]').first().fill(buyer.password);
  await page.locator("#btnLogin").click();
}

/** Logs the sandbox buyer into www.sandbox.paypal.com. */
export async function signInAsBuyer(page: Page, buyer: Buyer) {
  // www.sandbox.paypal.com does not always answer the first time.
  for (let attempt = 1; ; attempt++) {
    const ok = await page.goto("https://www.sandbox.paypal.com/signin", { timeout: 60_000 }).then(
      () => true,
      (err: unknown) => {
        if (attempt === 3) throw err;
        step(`  sandbox.paypal.com did not answer (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); trying again`);
        return false;
      },
    );
    if (ok) break;
  }
  await fillPayPalLogin(page, buyer);
  await page.waitForURL(/\/myaccount\//, { timeout: 90_000 });
}

/** Logs in inside PayPal's checkout popup and clicks through to approval. */
export async function approveInPopup(popup: Page, buyer: Buyer) {
  await popup.waitForLoadState("domcontentloaded");
  await fillPayPalLogin(popup, buyer);
  for (let i = 0; i < 20 && !popup.isClosed(); i++) {
    const button = popup.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      step(`  popup: clicking "${(await button.innerText().catch(() => "?")).trim().slice(0, 40)}"`);
      await button.click().catch(() => {});
    }
    await popup.waitForTimeout(2000).catch(() => {});
  }
}

export type SettledRental = { rentalId: string; captureId: string | null; authorizationId: string | null };

/**
 * Books the camera kit with the JS SDK v6 button (the buyer approves in
 * PayPal's popup), holds the deposit on the saved wallet, compares the
 * pickup and return photos with live Gemini, has the customer accept on
 * their page, and settles.
 */
export async function bookAndSettle(context: BrowserContext, base: string, buyer: Buyer, shot: (page: Page, name: string) => Promise<void>): Promise<SettledRental> {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") step(`  browser error: ${m.text().slice(0, 200)}`);
  });

  step("booking page");
  // The button renders once React has hydrated and the SDK is loaded; typing before that is lost.
  // www.sandbox.paypal.com sometimes fails to serve the SDK script; the page then says so and a reload helps.
  const button = page.locator("paypal-button");
  const failed = page.getByText("PayPal could not load");
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${base}/rent/camera-kit`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await button.or(failed).first().waitFor({ timeout: 90_000 });
    if (await button.isVisible()) break;
    if (attempt === 3) throw new Error("PayPal's JS SDK did not load after three tries");
    step("  PayPal's SDK did not load; reloading");
  }
  await page.getByLabel("Your name").fill("Maya Chen");
  await page.getByLabel("Email").fill("maya@example.com");
  await page.locator("paypal-button:not([disabled])").waitFor({ timeout: 30_000 });
  await shot(page, "s01-booking");
  step("clicking the PayPal button");
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 60_000 }), button.click()]);
  await approveInPopup(popup, buyer);
  await page.waitForURL(/\/r\//, { timeout: 90_000 });
  step(`booked: ${page.url()}`);
  await page.getByText(/Paid \$87\.00 with PayPal/).waitFor();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await page.getByText(/^Rental R-/).textContent()) ?? "")![0];
  await shot(page, "s02-customer-booked");

  const counter = await context.newPage();
  await counter.goto(`${base}/shop/rentals/${rentalId}`);
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
  const ids = (await counter.locator("dl.font-mono").innerText()).replace(/\s+/g, " ");
  step(`settled on PayPal sandbox: ${ids}`);
  await page.waitForTimeout(1500);
  await shot(page, "s06-customer-receipt");
  await page.close();
  await counter.close();
  return {
    rentalId,
    captureId: /capture ([0-9A-Z]{17})/.exec(ids)?.[1] ?? null,
    authorizationId: /authorization ([0-9A-Z]{17})/.exec(ids)?.[1] ?? null,
  };
}
