import { expect, test, type Page } from "@playwright/test";
import { E2E_SHOP_ACCESS_CODE } from "./staff-code";

// The simple views the counter falls back to when a commercial component does
// not load: the dashboard without AG Studio, the schedule without Bryntum.
// Runs on the staff-access server (playwright.config.ts), which sets the
// test-only switches INSIGHTS_FORCE_SIMPLE_VIEW=1 and
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

// The schedule's test runs first, so its sample fortnight is seeded before the dashboard's history.
// The project runs after the staff-access spec on the same server (playwright.config.ts).
test.describe.configure({ mode: "serial" });

test("the schedule shows its simple view, and the agent's suggestions are still approved and turned down there", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await signIn(counter, "/shop/schedule");
  await expect(counter.getByRole("heading", { name: "Who has what, and when" })).toBeVisible();

  const view = counter.getByTestId("schedule-simple-view");
  await expect(view.getByText("Simple schedule: the Bryntum timeline did not load")).toBeVisible();
  await expect(view.getByText(/This server sets SCHEDULE_FORCE_SIMPLE_VIEW, a switch for tests\./)).toBeVisible();
  await expect(view.getByRole("button", { name: "Try the timeline again" })).toBeVisible();
  // Bryntum itself was never loaded.
  await expect(counter.locator(".b-scheduler")).toHaveCount(0);

  const row = (unitId: string) => view.locator(`[data-testid="simple-unit-row"][data-unit-id="${unitId}"]`);
  const bar = (unitId: string, text: string) => row(unitId).getByTestId("simple-bar").filter({ hasText: text });
  await expect(row("projector-a")).toContainText("Projector A");
  await expect(bar("projector-a", "Jordan Lee")).toContainText("held");
  await expect(bar("projector-a", "Priya Patel")).toContainText("at pickup");
  await expect(bar("projector-a", "Diego Alvarez")).toBeVisible();
  // The staff-access spec books a camera kit first, so Grace's unit depends on the order; any unit will do.
  await expect(view.getByTestId("simple-bar").filter({ hasText: "Grace Liu" })).toBeVisible();
  await expect(bar("projector-a", "Jordan Lee")).toHaveAttribute("href", /\/shop\/rentals\/R-/);
  await expect(counter.getByTestId("proposal")).toHaveCount(0);
  await shot(counter, "schedule-simple-view");

  // Jordan brings the projector back with a cracked lens, accepts the charge on a phone, and the counter settles.
  await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Rentals" }).click();
  await counter.getByRole("link", { name: /Jordan Lee/ }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await counter.getByRole("button", { name: /Cracked lens glass/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await expect(counter.getByText("Replace projector lens").first()).toBeVisible();
  await counter.getByRole("button", { name: /Send 1 item to Jordan/ }).click();
  const customerUrl = await counter.getByRole("link", { name: /Customer's page/ }).getAttribute("href");
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(customerUrl!);
  await phone.getByRole("button", { name: "That's fair" }).click();
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await expect(phone.getByText("Thanks. The shop is reading your answers.")).toBeVisible();
  await counter.getByRole("button", { name: "Keep $160.00, release $40.00" }).click();
  await expect(counter.getByRole("heading", { name: "Settled" })).toBeVisible();

  // Back on the simple schedule: the repair block, the agent's suggested place, and the two suggestions with their buttons.
  await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Schedule" }).click();
  await expect(view).toBeVisible();
  const proposals = counter.getByTestId("proposal");
  await expect(proposals).toHaveCount(2);
  await expect(row("projector-a").locator('[data-kind="block"]')).toContainText("Replace projector lens");
  await expect(row("projector-b").locator('[data-kind="suggestion"]').filter({ hasText: "Suggested: Priya Patel" })).toContainText("move here from Projector A");
  await expect(row("projector-a")).toContainText("in repair");
  const move = proposals.filter({ hasText: "Move Priya Patel to Projector B" });
  const offer = proposals.filter({ hasText: "Offer Diego" });
  await expect(offer).toContainText("Call first");
  await shot(counter, "schedule-simple-view-proposals");

  // Approve: the server checks the move and Priya's booking is drawn on Projector B.
  await move.getByRole("button", { name: "Move to Projector B" }).click();
  await expect(bar("projector-b", "Priya Patel")).toBeVisible();
  await expect(bar("projector-a", "Priya Patel")).toHaveCount(0);
  await expect(row("projector-b").locator('[data-kind="suggestion"]')).toHaveCount(0);
  await expect(proposals).toHaveCount(1);

  // Turn down: Diego's booking stays where it is.
  await offer.getByRole("button", { name: "Turn down" }).click();
  await expect(proposals).toHaveCount(0);
  await expect(counter.getByText("Recently decided")).toBeVisible();
  await expect(bar("projector-a", "Diego Alvarez")).toBeVisible();
  await shot(counter, "schedule-simple-view-decided");
});

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
