import { expect, test, type Page } from "@playwright/test";
import { E2E_SHOP_ACCESS_CODE } from "./staff-code";

// The simple views the counter falls back to when a commercial component does
// not load. Runs on the staff-access server (playwright.config.ts), which
// sets the test-only switches INSIGHTS_FORCE_SIMPLE_VIEW=1 and
// SCHEDULE_FORCE_SIMPLE_VIEW=1 and, like the hosted copy, an access code.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

async function signIn(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel("Access code").fill(E2E_SHOP_ACCESS_CODE);
  await page.getByRole("button", { name: "Open the counter" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

const cents = (text: string) => Math.round(Number(text.replace(/[$,]/g, "")) * 100);

test("the insights page shows its simple view, with the same numbers, when AG Studio is not used", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, "/shop/insights");
  await expect(page.getByRole("heading", { name: "Where the deposit money went" })).toBeVisible();

  const view = page.getByTestId("insights-simple-view");
  await expect(view.getByText("Simple view: the AG Studio dashboard did not load")).toBeVisible();
  await expect(view.getByText(/This server sets INSIGHTS_FORCE_SIMPLE_VIEW, a switch for tests\./)).toBeVisible();
  await expect(view.getByText("The deposit desk is unavailable in the simple view: its chat runs inside AG Studio.")).toBeVisible();
  await expect(view.getByRole("button", { name: "Try AG Studio again" })).toBeVisible();
  // AG Studio itself was never loaded, and its page tabs and edit button are gone with it.
  await expect(page.locator(".ag-studio-root, [class*='ag-studio-']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Edit the layout|Edit and ask the deposit desk/ })).toHaveCount(0);

  // The Overview's KPIs, from the server's own sums.
  const kpi = (title: string) => view.getByTestId("simple-kpi").filter({ has: page.getByText(title, { exact: true }) }).getByTestId("simple-kpi-value");
  for (const title of ["Held on PayPal now", "Kept this month", "Released to renters", "Refunded"]) await expect(kpi(title)).toHaveText(/^\$[\d,]+\.\d\d$/);
  await expect(kpi("Open PayPal disputes")).toHaveText("1");
  await expect(kpi("Pickups photographed")).toHaveText("100%");
  await expect(kpi("Minutes, return photo to release")).toHaveText(/^\d/);

  // The two custom widgets, drawn outside AG Studio.
  const flow = view.getByTestId("deposit-flow");
  for (const node of ["Deposits held", "Released to renters", "Captured for repairs", "Kept by the shop"]) await expect(flow.getByText(node, { exact: true })).toBeVisible();
  const clock = view.getByTestId("hold-clock");
  await expect(clock.getByText("72 h", { exact: true })).toBeVisible();
  await expect(clock.getByRole("img", { name: /held .* of 29 days/ }).first()).toBeVisible();
  await expect(clock.getByText("The renter has answered; ready to settle.", { exact: true }).first()).toBeVisible();

  // Held on PayPal now is the sum of the holds on the clock, each row "R-XXXXXX · $300.00".
  const rows = await clock.locator(".hb-clock-sub").allTextContents();
  expect(rows.length).toBeGreaterThan(0);
  const onClock = rows.reduce((sum, r) => sum + cents(r.split("·")[1] ?? "0"), 0);
  expect(cents((await kpi("Held on PayPal now").textContent()) ?? "")).toBe(onClock);

  // The ledger as a plain table.
  const ledger = view.getByTestId("simple-ledger");
  await expect(ledger.getByRole("cell", { name: "Rental fee captured" }).first()).toBeVisible();
  await expect(ledger.getByRole("cell", { name: /^DEMO-CAPTURE-\d+$/ }).first()).toBeVisible();
  expect(await ledger.locator("tbody tr").count()).toBeGreaterThan(20);
  await shot(page, "insights-simple-view");
});
