import { expect, test, type Locator, type Page } from "@playwright/test";

// The schedule in demo mode: two weeks of sample bookings are loaded the
// first time it opens. Jordan Lee's projector (Projector A) is due back
// today; Priya Patel and Diego Alvarez are booked on the same unit later.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  // Bryntum fades the bars in one after another when the timeline first loads.
  await expect(page.locator(".b-scheduler.b-initial-fade-in")).toHaveCount(0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

/** A real booking's bar (rental ids start with R-), not the agent's dashed suggestion. */
const bar = (page: Page, name: string) => page.locator('.b-sch-event-wrap[data-event-id^="R-"]', { hasText: name });
const ghost = (page: Page, name: string) => page.locator('.b-sch-event-wrap[data-event-id^="ghost:"]', { hasText: name });
/** Maya Chen also books a camera kit in rental-flow.spec.ts; her drone booking is the one on a drone row. */
const mayaDrone = (page: Page) => page.locator('.b-sch-event-wrap[data-event-id^="R-"][data-resource-id^="drone-kit"]', { hasText: "Maya Chen" });

test.describe.configure({ mode: "serial" });

test("a damaged return makes the agent suggest a move, and one click moves the bar", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();

  // 1. The schedule opens with the sample bookings; nothing needs a decision yet.
  await counter.goto("/shop/schedule");
  await expect(counter.getByRole("heading", { name: "Who has what, and when" })).toBeVisible();
  await expect(bar(counter, "Grace Liu")).toBeVisible();
  await expect(counter.getByTestId("proposal")).toHaveCount(0);
  await shot(counter, "s01-schedule");

  // 2. Jordan brings the projector back with a cracked lens.
  await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Rentals" }).click();
  await counter.getByRole("link", { name: /Jordan Lee/ }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await counter.getByRole("button", { name: /Cracked lens glass/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await expect(counter.getByText("Replace projector lens").first()).toBeVisible();
  await counter.getByRole("button", { name: /Send 1 item to Jordan/ }).click();

  // 3. Jordan accepts the charge on their phone, and the counter settles.
  const customerUrl = await counter.getByRole("link", { name: /Customer's page/ }).getAttribute("href");
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(customerUrl!);
  await phone.getByRole("button", { name: "That's fair" }).click();
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await expect(phone.getByText("Thanks. The shop is reading your answers.")).toBeVisible();
  await counter.getByRole("button", { name: "Keep $160.00, release $40.00" }).click();
  await expect(counter.getByRole("heading", { name: "Settled" })).toBeVisible();
  await expect(counter.getByText("Unit taken off the schedule for the repair")).toBeVisible();

  // 4. On the schedule: Projector A is in repair, Priya can move to Projector B, Diego needs a call.
  await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Schedule" }).click();
  const proposals = counter.getByTestId("proposal");
  await expect(proposals).toHaveCount(2);
  const move = proposals.filter({ hasText: "Move Priya Patel to Projector B" });
  await expect(proposals.filter({ hasText: "Offer Diego" })).toContainText("Call first");
  await expect(move.getByTestId("proposal-message")).toContainText("Hi Priya");

  // Pointing at the suggestion brings both bars into view: Priya's, and the dashed one where it would go.
  await move.hover();
  await expect(bar(counter, "Priya Patel")).toHaveAttribute("data-resource-id", "projector-a");
  await expect(ghost(counter, "Priya Patel")).toHaveAttribute("data-resource-id", "projector-b");
  await expect(counter.locator(".b-sch-resource-time-range", { hasText: "Replace projector lens" })).toBeVisible();
  await shot(counter, "s02-proposals");

  // 5. One click: the server checks the move again, and the bar moves to Projector B.
  await move.getByRole("button", { name: "Move to Projector B" }).click();
  await expect(bar(counter, "Priya Patel")).toHaveAttribute("data-resource-id", "projector-b");
  await expect(ghost(counter, "Priya Patel")).toHaveCount(0);
  await expect(proposals).toHaveCount(1);
  await expect(counter.getByText("Recently decided")).toBeVisible();
  await shot(counter, "s03-moved");

  // The move is on Priya's audit trail.
  await bar(counter, "Priya Patel").dblclick();
  await expect(counter.getByText("Moved to another unit of the same item")).toBeVisible();
  await expect(counter.getByText("projector-a → projector-b · agent's suggestion, approved")).toBeVisible();
  await expect(counter.getByText(/Audit chain intact/)).toBeVisible();

  // 6. At pickup the counter is told which unit to give Priya: Projector B, not the one in repair.
  await expect(counter.getByTestId("handover")).toContainText("Hand over Projector B");
  await expect(counter.getByText(/Check before handing over/)).toHaveCount(0);

  // Diego is still on Projector A, which is in repair on his first day; the rentals list and his rental both say so.
  await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Rentals" }).click();
  const diego = counter.getByRole("link", { name: /Diego Alvarez/ });
  await expect(diego).toContainText("hand over Projector A");
  await expect(diego).toContainText("Projector A is in repair");
  await diego.click();
  await expect(counter.getByTestId("handover")).toContainText("Hand over Projector A");
  await expect(counter.getByText("Check before handing over Projector A")).toBeVisible();
  await expect(counter.getByText(/Projector A is in repair .* \(Replace projector lens\)\. Move this booking/)).toBeVisible();
  await shot(counter, "s06-handover-warning");
});

test("a typed command is read, checked, and only applied after a click", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await counter.goto("/shop/schedule");
  await expect(mayaDrone(counter)).toHaveAttribute("data-resource-id", "drone-kit-a");

  const reply = counter.getByTestId("command-reply");
  await counter.getByLabel("Tell the schedule").fill("Move Maya's drone booking to Projector B");
  await counter.getByRole("button", { name: "Suggest" }).click();
  await expect(reply).toContainText("Not possible, nothing changed");
  await expect(reply).toContainText("Projector B is not a Folding camera drone kit");

  await counter.getByLabel("Tell the schedule").fill("Move Maya's drone booking to the other unit");
  await counter.getByRole("button", { name: "Suggest" }).click();
  await expect(reply).toContainText("Move Maya Chen from Drone kit A to Drone kit B");
  // Nothing has moved yet.
  await expect(mayaDrone(counter)).toHaveAttribute("data-resource-id", "drone-kit-a");
  await shot(counter, "s04-command");
  await reply.getByRole("button", { name: "Confirm" }).click();
  await expect(counter.getByText("Done. The schedule has been updated.")).toBeVisible();
  await expect(mayaDrone(counter)).toHaveAttribute("data-resource-id", "drone-kit-b");
});

/**
 * Drags a bar vertically onto another unit's row, the way a hand would:
 * rest on the bar, press, then move in small steps. Bryntum ignores the
 * pointer on bars while the timeline scrolls (and it scrolls to today once
 * it loads), so the press waits until the bar itself is under the pointer.
 */
async function dragToRow(page: Page, bar: Locator, unitId: string, drop = true) {
  await bar.scrollIntoViewIfNeeded();
  const id = await bar.getAttribute("data-event-id");
  const grip = async () => {
    const box = (await bar.boundingBox())!;
    return { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 };
  };
  await expect
    .poll(async () => {
      const { x, y } = await grip();
      return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".b-sch-event-wrap")?.getAttribute("data-event-id") ?? null, [x, y]);
    })
    .toBe(id);
  const { x, y } = await grip();
  const row = (await page.locator(`.b-grid-row[data-id="${unitId}"]`).last().boundingBox())!;
  const toY = row.y + row.height / 2;
  await page.mouse.move(x, y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(100);
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(x + 1, y + ((toY - y) * i) / 16);
    await page.waitForTimeout(25);
  }
  await expect(page.locator(".b-dragging").first()).toBeAttached();
  if (drop) await page.mouse.up();
}

test("dragging a booking to another unit is checked by the server", async ({ browser }) => {
  const counter = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await counter.goto("/shop/schedule");
  const maya = mayaDrone(counter);
  await expect(maya).toHaveAttribute("data-resource-id", "drone-kit-b");

  // Kai's booking overlaps the day Alex brings Drone kit A back: the drag shows why, and the drop changes nothing.
  const kai = bar(counter, "Kai Tanaka");
  await expect(kai).toHaveAttribute("data-resource-id", "drone-kit-b");
  await dragToRow(counter, kai, "drone-kit-a", false);
  await expect(counter.locator(".hb-drag-tip-bad")).toContainText("Drone kit A is booked by Alex Kim then");
  await shot(counter, "s05-drag-refused");
  await counter.mouse.up();
  await expect(kai).toHaveAttribute("data-resource-id", "drone-kit-b");

  // Maya's fits: the server checks it again, and the bar stays on Drone kit A.
  await dragToRow(counter, maya, "drone-kit-a");
  await expect(counter.getByRole("status").filter({ hasText: "Maya Chen moved to Drone kit A." })).toBeVisible();
  await expect(maya).toHaveAttribute("data-resource-id", "drone-kit-a");

  // The move is on Maya's audit trail, marked as a drag at the counter.
  await maya.dblclick();
  await expect(counter.getByText("drone-kit-b → drone-kit-a · dragged on the schedule")).toBeVisible();
  await expect(counter.getByText("drone-kit-a → drone-kit-b · typed request, confirmed")).toBeVisible();
});
