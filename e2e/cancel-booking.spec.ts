import { expect, test, type Page } from "@playwright/test";

// The renter changes plans: they cancel a paid booking on their phone well
// before pickup, get the whole fee back under the cancellation policy, and
// the counter's page and list show it without a reload.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("the renter cancels on their phone before pickup, gets the fee back, and the counter sees it at once", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();

  // 1. The booking page states the cancellation policy next to the price list.
  await phone.goto("/rent/tele-lens");
  await expect(phone.getByText("If you cancel before pickup")).toBeVisible();
  await expect(phone.getByText(/at least 24 hours before the pickup day starts \(00:00 UTC\) and you get back the whole rental fee/)).toBeVisible();
  // Ten days ahead, so the whole fee comes back.
  await phone.getByLabel("Pickup").fill(daysFromToday(10));
  await phone.getByLabel("Return").fill(daysFromToday(12));
  await phone.getByLabel("Your name").fill("Lena Park");
  await phone.getByLabel("Email").fill("lena@example.com");
  await phone.getByRole("button", { name: "Pay $70.00 (demo PayPal)" }).click();
  await phone.waitForURL(/\/r\//);
  await expect(phone.getByText("Paid $70.00 with PayPal")).toBeVisible();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];

  // 2. The counter has the booking open, waiting for pickup.
  await counter.goto(`/shop/rentals/${rentalId}`);
  await expect(counter.getByRole("heading", { name: "Pickup" })).toBeVisible();
  await expect(counter.getByRole("heading", { name: "Cancel the booking" })).toBeVisible();

  // 3. The renter cancels on their phone and confirms.
  await expect(phone.getByRole("heading", { name: "Need to cancel?" })).toBeVisible();
  await expect(phone.getByText(/If you cancel now, you get back \$70\.00 of the \$70\.00 rental fee/)).toBeVisible();
  await shot(phone, "x01-renter-cancel");
  await phone.getByRole("button", { name: "Cancel this booking" }).click();
  await phone.getByRole("button", { name: "Yes, cancel and refund $70.00" }).click();
  await expect(phone.getByRole("heading", { name: "You cancelled this booking" })).toBeVisible();
  await expect(phone.getByText("Refund 1: refunded on PayPal")).toBeVisible();
  await expect(phone.getByText("The shop keeps")).toBeVisible();
  await shot(phone, "x02-renter-cancelled");

  // 4. The counter's page updates by itself: cancelled, refunded, nothing to hold.
  await expect(counter.getByRole("heading", { name: "Cancelled", exact: true })).toBeVisible();
  await expect(counter.getByText(/Cancelled before pickup by the customer/)).toBeVisible();
  await expect(counter.getByText(/^refund DEMO-REFUND-/).first()).toBeVisible();
  await expect(counter.getByRole("heading", { name: "Pickup" })).toHaveCount(0);
  await expect(counter.getByRole("button", { name: /^Hold \$/ })).toHaveCount(0);
  await expect(counter.getByText("None held: the booking was cancelled before pickup.")).toBeVisible();
  await shot(counter, "x03-counter-cancelled");

  // 5. The counter's list files it under Cancelled with the refund.
  await counter.goto("/shop");
  const row = counter.getByRole("link", { name: new RegExp(rentalId) });
  await expect(row).toContainText("Cancelled");
  await expect(row).toContainText("$70.00 of $70.00 fee refunded");
});

test("the counter cancels with a refund it chooses and a reason, and the renter's phone shows both at once", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();

  // The renter books the action camera kit three weeks ahead: 2 days, $38.00.
  await phone.goto("/rent/action-cam-kit");
  await phone.getByLabel("Pickup").fill(daysFromToday(20));
  await phone.getByLabel("Return").fill(daysFromToday(22));
  await phone.getByLabel("Your name").fill("Omar Diaz");
  await phone.getByLabel("Email").fill("omar@example.com");
  await phone.getByRole("button", { name: "Pay $38.00 (demo PayPal)" }).click();
  await phone.waitForURL(/\/r\//);
  await expect(phone.getByText("Paid $38.00 with PayPal")).toBeVisible();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];

  // The counter's form starts at what the policy gives ($38.00 this early); staff refund $30.00 with a reason.
  await counter.goto(`/shop/rentals/${rentalId}`);
  await expect(counter.getByText(/The cancellation policy gives Omar \$38\.00 \(100%\) now/)).toBeVisible();
  await expect(counter.getByLabel("Refund")).toHaveValue("38.00");
  await counter.getByLabel("Refund").fill("38.01");
  await counter.getByLabel("Reason Omar sees").fill("The camera failed its check before your rental");
  await expect(counter.getByRole("button", { name: "Cancel booking" })).toBeDisabled();
  await counter.getByLabel("Refund").fill("30");
  await counter.getByRole("button", { name: "Cancel booking" }).click();
  await counter.getByRole("button", { name: "Yes, cancel and refund $30.00" }).click();
  await expect(counter.getByRole("heading", { name: "Cancelled", exact: true })).toBeVisible();
  await expect(counter.getByText(/Cancelled before pickup by the counter/)).toBeVisible();
  await expect(counter.getByText("Kept of the fee")).toBeVisible();
  // What is left of the fee can still be refunded from the same page.
  await expect(counter.getByText(/At most \$8\.00 is left to refund on the rental fee/)).toBeVisible();
  await shot(counter, "x04-counter-cancelled-by-shop");

  // The renter's page shows the shop's cancellation, the reason and the refund without a reload.
  await expect(phone.getByRole("heading", { name: "Kestrel Rentals cancelled this booking" })).toBeVisible();
  await expect(phone.getByText(/The camera failed its check before your rental/)).toBeVisible();
  await expect(phone.getByText("−$30.00")).toBeVisible();
  await expect(phone.getByText("The shop keeps").locator("..")).toContainText("$8.00");
  await shot(phone, "x05-renter-cancelled-by-shop");
});
