import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  // Let the money-bar animation finish so the screenshot shows the final state.
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test("a rental from booking to a fair settlement, with the customer on their phone", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();

  // 1. The customer books on their phone: fee paid, PayPal saved, no deposit yet.
  await phone.goto("/rent/camera-kit");
  await phone.getByLabel("Your name").fill("Maya Chen");
  await phone.getByLabel("Email").fill("maya@example.com");
  await shot(phone, "01-booking");
  await phone.getByRole("button", { name: /Pay \$\d+\.\d\d \(demo PayPal\)/ }).click();
  await phone.waitForURL(/\/r\//);
  await expect(phone.getByText("Paid $87.00 with PayPal")).toBeVisible();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];
  await shot(phone, "02-customer-booked");

  // 2. The counter sees the booking, photographs the kit and holds the deposit.
  await counter.goto("/shop");
  await counter.getByRole("link", { name: new RegExp(rentalId) }).click();
  await expect(counter.getByRole("heading", { name: "Pickup" })).toBeVisible();
  await shot(counter, "03-counter-pickup");
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await counter.getByRole("button", { name: "Hold $300.00 deposit" }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await shot(counter, "04-counter-out");

  // 3. The customer's page updates by itself; they confirm the pickup photo.
  await expect(phone.getByText("$300.00 held on PayPal")).toBeVisible();
  await phone.getByRole("button", { name: "Yes, this is how I received it" }).click();
  await expect(phone.getByText(/You confirmed this photo/)).toBeVisible();
  await shot(phone, "05-customer-held");

  // 4. Return: the lens hood is missing. Two looks compare the photos.
  await counter.getByRole("button", { name: /Hood removed/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await expect(counter.getByText("Replace lens hood")).toBeVisible();
  await shot(counter, "06-counter-findings");
  await counter.getByRole("button", { name: /Send 1 item to Maya/ }).click();

  // 5. The customer reviews on their phone and accepts.
  await expect(phone.getByRole("heading", { name: "Please review what the shop found" })).toBeVisible();
  await shot(phone, "07-customer-review");
  await phone.getByRole("button", { name: "That's fair" }).click();
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await expect(phone.getByText("Thanks. The shop is reading your answers.")).toBeVisible();

  // 6. The counter settles: $35 kept, $265 released.
  await counter.getByRole("button", { name: "Keep $35.00, release $265.00" }).click();
  await expect(counter.getByRole("heading", { name: "Settled" })).toBeVisible();
  await shot(counter, "08-counter-settled");
  await expect(phone.getByText("Deposit released to your PayPal")).toBeVisible();
  await expect(phone.getByText("$265.00").first()).toBeVisible();
  await shot(phone, "09-customer-receipt");
  await expect(counter.getByText(/Audit chain intact/)).toBeVisible();
});
