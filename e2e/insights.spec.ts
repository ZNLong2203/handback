import { expect, test, type Page } from "@playwright/test";

// The owner's dashboard in demo mode: AG Studio loads in the browser with the
// sample history, the KPIs and both custom widgets draw, a click on the
// deposit flow cross-filters the page, and the other pages open from the tabs.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test("the insights dashboard shows where the deposits went, the hold clock, and filters on a click", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto("/shop/insights");
  await expect(page.getByRole("heading", { name: "Where the deposit money went" })).toBeVisible();
  // The assistant says plainly whether it is on, and what it needs when it is not.
  await expect(page.getByText(/Deposit desk agent on (Gemini|a test script)|AI assistant needs (a Gemini key|an access code)/).first()).toBeVisible();
  await expect(page.getByText(/AG Studio, a commercial component/)).toBeVisible();

  // KPIs from AG Studio's value widgets.
  for (const title of ["Held on PayPal now", "Kept this month", "Released to renters", "Refunded", "Open PayPal disputes", "Pickups photographed"]) {
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.getByText("100%", { exact: true })).toBeVisible();

  // Custom widget 1: where the deposits went.
  const flow = page.getByTestId("deposit-flow");
  await expect(flow.getByText("Deposits held", { exact: true })).toBeVisible();
  await expect(flow.getByText("Released to renters", { exact: true })).toBeVisible();
  await expect(flow.getByText("Captured for repairs", { exact: true })).toBeVisible();

  // Custom widget 2: the hold clock, one row per running hold.
  const clock = page.getByTestId("hold-clock");
  await expect(clock.getByText("72 h", { exact: true })).toBeVisible();
  await expect(clock.getByRole("button", { name: /held .* of 29 days/ }).first()).toBeVisible();
  // Other specs on the same server can have a renter who has answered too.
  await expect(clock.getByText("The renter has answered; ready to settle.", { exact: true }).first()).toBeVisible();
  await shot(page, "insights-overview");

  // A click on a band filters the page: rentals whose deposit was captured have no running hold.
  await flow.getByRole("button", { name: /^Deposits held → Captured for repairs/ }).click();
  await expect(page.getByText("No data to display").first()).toBeVisible();
  await expect(clock.getByRole("button", { name: /held .* of 29 days/ }).first()).toHaveAttribute("opacity", "0.3");

  // The other pages.
  await page.getByRole("button", { name: "Ledger", exact: true }).click();
  await expect(page.getByText("Every PayPal movement", { exact: true })).toBeVisible();
  await expect(page.getByText("Rental fee captured").first()).toBeVisible();
  await page.getByRole("button", { name: "Holds", exact: true }).click();
  await expect(page.getByText("Running holds", { exact: true })).toBeVisible();
});
