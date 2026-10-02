import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

/** The rental flow up to a settled $35 lens-hood charge the customer accepted on their phone. */
async function settledRental(counter: Page, phone: Page): Promise<string> {
  await phone.goto("/rent/camera-kit");
  await phone.getByLabel("Your name").fill("Maya Chen");
  await phone.getByLabel("Email").fill("maya@example.com");
  await phone.getByRole("button", { name: /Pay \$\d+\.\d\d \(demo PayPal\)/ }).click();
  await phone.waitForURL(/\/r\//);
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];
  await counter.goto(`/shop/rentals/${rentalId}`);
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await counter.getByRole("button", { name: "Hold $300.00 deposit" }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await phone.getByRole("button", { name: "Yes, this is how I received it" }).click();
  await expect(phone.getByText(/You confirmed this photo/)).toBeVisible();
  await counter.getByRole("button", { name: /Hood removed/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await counter.getByRole("button", { name: /Send 1 item to Maya/ }).click();
  await phone.getByRole("button", { name: "That's fair" }).click();
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await counter.getByRole("button", { name: "Keep $35.00, release $265.00" }).click();
  await expect(counter.getByRole("heading", { name: "Settled" })).toBeVisible();
  return rentalId;
}

test("the counter answers a PayPal dispute with the evidence pack and the case is decided", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const rentalId = await settledRental(counter, phone);

  // The customer disputes the charge (in demo mode, the stand-in plays PayPal).
  await counter.getByRole("button", { name: /customer disputes this charge/ }).click();
  const panel = counter.getByRole("region", { name: "Charged the wrong amount" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Your answer needed")).toBeVisible();
  await expect(panel.getByText("Fight: the customer accepted these charges before they were taken.")).toBeVisible();
  await expect(panel.getByText(/\$20\.00 of the \$35\.00 damage capture/)).toBeVisible();
  await shot(counter, "d01-dispute-opened");

  // The customer's page shows a calm notice, not an accusation.
  await phone.reload();
  await expect(phone.getByText("Your case with PayPal")).toBeVisible();
  await shot(phone, "d02-customer-case-open");

  // Prepare the pack: one PDF, content-addressed.
  await panel.getByRole("button", { name: "Prepare the evidence pack" }).click();
  const open = panel.getByRole("link", { name: "Open the PDF" });
  await expect(open).toBeVisible();
  const href = (await open.getAttribute("href"))!;
  const pdf = await counter.request.get(href);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await shot(counter, "d03-pack-prepared");

  // Sending asks once more, then files the pack and both photos.
  await panel.getByRole("button", { name: "Send to PayPal" }).click();
  await panel.getByRole("button", { name: "Send the pack and both photos to PayPal" }).click();
  await expect(panel.getByText("PayPal is reviewing")).toBeVisible();
  await expect(panel.getByText(new RegExp(`${rentalId}-evidence\\.pdf, ${rentalId}-pickup\\.jpg, ${rentalId}-return\\.jpg`))).toBeVisible();
  await shot(counter, "d04-evidence-sent");

  // Playing PayPal's part: ask again, answer again, then decide.
  await panel.getByRole("button", { name: "PayPal asks the shop for evidence" }).click();
  await expect(panel.getByText("Your answer needed")).toBeVisible();
  await expect(panel.getByText("proof of shipment, proof of a refund, a delivery signature")).toBeVisible();
  await panel.getByRole("button", { name: "Send to PayPal" }).click();
  await panel.getByRole("button", { name: "Send the pack and both photos to PayPal" }).click();
  await expect(panel.getByText("PayPal is reviewing")).toBeVisible();
  await panel.getByRole("button", { name: "PayPal decides for the shop" }).click();
  await expect(panel.getByText("The shop keeps the charge.")).toBeVisible();
  await expect(counter.getByText("PayPal closed the dispute")).toBeVisible();
  await expect(counter.getByText(/Audit chain intact/)).toBeVisible();
  await shot(counter, "d05-decided");

  await phone.reload();
  await expect(phone.getByText("PayPal closed the case")).toBeVisible();
  await shot(phone, "d06-customer-closed");
});
