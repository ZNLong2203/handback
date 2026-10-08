import { expect, test, type Locator, type Page } from "@playwright/test";

// The demo video's story, from a bicycle rental shop's most common losses:
// a city bike comes back without its phone holder and rear light. The renter
// accepts the phone holder charge and questions the rear light, the counter
// waives it, and PayPal keeps only the phone holder's price.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  // Let the money-bar animation finish so the screenshot shows the final state.
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
/** One card of the page, for the README: docs/images/customer-review.png is this shot of the review card. */
const shotOf = async (card: Locator, name: string) => {
  if (!SHOTS) return;
  // Playwright's clicks are mouse clicks even here, so move the pointer off the cards first:
  // a finger on a real phone leaves no hover highlight behind.
  await card.page().mouse.move(0, 0);
  await card.page().waitForTimeout(400);
  await card.screenshot({ path: `${SHOTS}/${name}.png` });
};

test("a city bike back without its phone holder and rear light: one charge accepted, one questioned and waived", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();

  // 1. The renter books the bike on their phone: $15 a day, a $150 deposit held at pickup.
  await phone.goto("/rent/city-bike");
  await expect(phone.getByRole("heading", { name: "City bike" })).toBeVisible();
  await expect(phone.getByText("Replace phone holder")).toBeVisible();
  await phone.getByLabel("Your name").fill("An Nguyen");
  await phone.getByLabel("Email").fill("an.nguyen@example.com");
  await shot(phone, "b01-booking");
  await phone.getByRole("button", { name: "Pay $45.00 (demo PayPal)" }).click();
  await phone.waitForURL(/\/r\//);
  await expect(phone.getByText("Paid $45.00 with PayPal")).toBeVisible();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];

  // 2. At pickup the counter photographs the bike with all four accessories and holds the deposit.
  await counter.goto("/shop");
  await counter.getByRole("link", { name: new RegExp(rentalId) }).click();
  await expect(counter.getByRole("heading", { name: "Pickup" })).toBeVisible();
  await shot(counter, "b02-counter-pickup");
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await counter.getByRole("button", { name: "Hold $150.00 deposit" }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await expect(phone.getByText("$150.00 held on PayPal")).toBeVisible();
  await phone.getByRole("button", { name: "Yes, this is how I received it" }).click();
  await shot(counter, "b03-counter-return");

  // 3. Back without the phone holder and the rear light. Both looks see both.
  await counter.getByRole("button", { name: /Phone holder removed, rear light removed/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await expect(counter.getByText("Replace phone holder")).toBeVisible();
  await expect(counter.getByText("Replace rear light")).toBeVisible();
  await shot(counter, "b04-counter-findings");
  await counter.getByRole("button", { name: /Send 2 items to An/ }).click();

  // 4. On their phone the renter accepts the phone holder and questions the rear light.
  await expect(phone.getByRole("heading", { name: "Please review what the shop found" })).toBeVisible();
  const holder = phone.getByRole("group", { name: "Your answer for phone holder" });
  const rearLight = phone.getByRole("group", { name: "Your answer for rear light" });
  await holder.getByRole("button", { name: "That's fair" }).click();
  await rearLight.getByRole("button", { name: "I question this" }).click();
  await rearLight.getByRole("textbox").fill("It's in my backpack");
  await shot(phone, "b05-customer-answers");
  await shotOf(phone.locator("section", { has: phone.getByRole("heading", { name: "Please review what the shop found" }) }), "b05-customer-review-card");
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await expect(phone.getByText("Thanks. The shop is reading your answers.")).toBeVisible();

  // 5. The counter reads the note, waives the rear light and settles: $12 kept, $138 released.
  await expect(counter.getByText("It's in my backpack")).toBeVisible();
  await counter.getByRole("button", { name: "Waive it" }).click();
  await counter.getByRole("button", { name: "Keep $12.00, release $138.00" }).click();
  await expect(counter.getByRole("heading", { name: "Settled" })).toBeVisible();
  // docs/images/counter-settled.png is this shot.
  await shot(counter, "b06-counter-settled");
  await expect(phone.getByText("Deposit released to your PayPal")).toBeVisible();
  await expect(phone.getByText("$138.00").first()).toBeVisible();
  await shot(phone, "b07-customer-receipt");
  await expect(counter.getByText(/Audit chain intact/)).toBeVisible();
});
