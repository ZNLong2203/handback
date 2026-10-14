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

test("when AG Studio's code does not load, the page falls back to the simple view and says why", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Every script that carries AG Studio's code fails to load, as on a flaky network or a deploy that removed the chunks.
  let blocked = 0;
  await page.route("**/_next/static/**/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("ag-studio-watermark")) {
      blocked++;
      return route.abort();
    }
    return route.fulfill({ response, body });
  });
  await page.goto("/shop/insights");
  const view = page.getByTestId("insights-simple-view");
  await expect(view.getByText("Simple view: the AG Studio dashboard did not load")).toBeVisible();
  await expect(view.getByText(/It stopped with an error in this browser\./)).toBeVisible();
  await expect(view.getByText("The deposit desk is unavailable in the simple view: its chat runs inside AG Studio.")).toBeVisible();
  expect(blocked).toBeGreaterThan(0);
  await expect(view.getByTestId("simple-kpi")).toHaveCount(7);
  await expect(view.getByTestId("deposit-flow").getByText("Deposits held", { exact: true })).toBeVisible();
  await expect(view.getByTestId("hold-clock").getByText("72 h", { exact: true })).toBeVisible();
  await expect(view.getByTestId("simple-ledger").getByRole("cell", { name: "Rental fee captured" }).first()).toBeVisible();
  await shot(page, "insights-simple-view-load-failed");

  // Trying again reloads the page; with the network back, AG Studio draws.
  await page.unroute("**/_next/static/**/*.js");
  await view.getByRole("button", { name: "Try AG Studio again" }).click();
  await expect(page.getByTestId("insights-simple-view")).toHaveCount(0);
  await expect(page.getByText("Held on PayPal now", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("deposit-flow").getByRole("button", { name: /^Deposits held → / }).first()).toBeVisible();
});
