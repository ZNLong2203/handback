/**
 * The schedule after a damaged return, and the owner's dashboard. They need
 * more than one rental, so they come from a server that has sample rentals:
 *
 *   - demo mode (the default): the PayPal stand-in, recorded Gemini replies,
 *     and the sample data the schedule and the dashboard book the first time
 *     they open. Run it against a fresh server: the schedule is photographed
 *     first, before the dashboard's six weeks of history are booked onto it.
 *   - the live target (--shop-pages live): a PayPal sandbox server the
 *     sandbox seed has filled (the nightly demo reset, or `npm run seed:demo`
 *     with SEED_VAULT_ID). Settling Jordan's projector there is one real
 *     sandbox capture, after two Gemini looks (live with a key, otherwise
 *     the recorded replies). The dashboard shows only the sandbox's real
 *     movements: no sample history is seeded there.
 *
 * Either way the pages' own mode strip is recorded, and the slides say which.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { idsFromCounter, modeStrip } from "./capture-live";
import { log, type Manifest, type ShotTaker } from "./shots";
import { counterContext } from "./staff";

export type ShopSource = "live" | "demo";

const DESK = { locale: "en-US", viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 2 } as const;
const PHONE = { locale: "en-US", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } as const;

async function checkMode(base: string, from: ShopSource) {
  const health = (await (await fetch(`${base}/api/health`)).json()) as { paypal?: { mode?: string } };
  const want = from === "live" ? "sandbox" : "demo";
  if (health.paypal?.mode !== want) throw new Error(`${base} must run with PayPal ${want} for --shop-pages ${from}; /api/health says PayPal ${health.paypal?.mode}`);
}

/**
 * Jordan's projector comes back with a cracked lens, Jordan accepts on a
 * phone, and the counter settles; the agent then blocks the unit and suggests
 * a fix for the bookings after it. When a run before this one already did
 * that (Jordan's rental is no longer out and a suggestion is waiting), it
 * only photographs the schedule. Returns the settled rental's id, if it
 * settled one.
 */
async function damagedReturn(counter: Page, phoneCtx: BrowserContext, base: string): Promise<string | null> {
  await counter.goto(`${base}/shop`);
  await counter.getByRole("heading", { name: "Today at the counter" }).waitFor({ timeout: 60_000 });
  // The counter seed has a Jordan Lee too (a projector waiting for the renter's answers); the one out now is the schedule's.
  const outNow = counter.locator("section", { has: counter.getByRole("heading", { name: "Out now", exact: true }) });
  const jordan = outNow.getByRole("link", { name: /Jordan Lee/ });
  if (!(await jordan.count())) {
    log("schedule: no Jordan Lee out now; photographing the suggestions an earlier run left");
    return null;
  }
  log("schedule: Jordan's projector comes back with a cracked lens");
  await jordan.first().click();
  await counter.getByRole("heading", { name: "Return" }).waitFor();
  const rentalId = /R-[0-9A-Z]{6}/.exec(counter.url())![0];
  await counter.getByRole("button", { name: /Cracked lens glass/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await counter.getByRole("heading", { name: "What the photos show" }).waitFor({ timeout: 180_000 });
  const send = counter.getByRole("button", { name: /Send \d+ items? to Jordan/ });
  if (!(await counter.getByText("Replace projector lens").count()) || !(await send.isVisible().catch(() => false))) {
    throw new Error(`the two looks did not both propose the projector lens on ${rentalId}; nothing was charged, and the rental waits at the counter`);
  }
  await send.click();
  const customerUrl = await counter.getByRole("link", { name: /Customer's page/ }).getAttribute("href");
  const phone = await phoneCtx.newPage();
  await phone.goto(new URL(customerUrl!, base).toString());
  await phone.getByRole("button", { name: "That's fair" }).first().waitFor({ timeout: 30_000 });
  for (const fair of await phone.getByRole("button", { name: "That's fair" }).all()) await fair.click();
  await phone.getByRole("button", { name: "Send my answers" }).click();
  await phone.getByText("Thanks. The shop is reading your answers.").waitFor({ timeout: 30_000 });
  await counter.getByRole("button", { name: /^Keep \$\d/ }).click();
  await counter.getByRole("heading", { name: "Settled" }).waitFor({ timeout: 90_000 });
  return rentalId;
}

async function scheduleShots(browser: Browser, base: string, from: ShopSource, taker: ShotTaker, manifest: Manifest) {
  const ctx = await counterContext(browser, base, DESK);
  const phoneCtx = await browser.newContext(PHONE);
  try {
    const counter = await ctx.newPage();
    log(from === "demo" ? "schedule: seeding two weeks of sample bookings" : "schedule: the sandbox seed's bookings");
    await counter.goto(`${base}/shop/schedule`);
    await counter.getByRole("heading", { name: "Who has what, and when" }).waitFor({ timeout: 120_000 });

    const settled = await damagedReturn(counter, phoneCtx, base);
    if (settled && from === "live") {
      const ids = await idsFromCounter(counter);
      Object.assign(manifest.facts, { liveRepairRentalId: settled, liveRepairCaptureId: ids.settlementCaptureId });
    }

    await counter.goto(`${base}/shop/schedule`);
    const proposals = counter.getByTestId("proposal");
    await proposals.first().waitFor({ timeout: 60_000 });
    const move = proposals.filter({ hasText: /Move Priya Patel to / });
    await move.first().waitFor({ timeout: 30_000 });
    // Projector B in demo mode; in the sandbox the story runs on Projector B, so Priya moves to Projector A.
    const toUnit = /Move Priya Patel to (\w+ [A-Z])\b/.exec(await move.first().innerText())?.[1] ?? "";
    // Bryntum fades the bars in after the first load.
    await counter.locator(".b-scheduler.b-initial-fade-in").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    // The timeline is 640px tall, scrolls inside and draws only the rows near what is on screen. Scroll
    // down until both projector rows are drawn, then centre them, so the repair block and the dashed bar
    // where Priya's booking would go are both in the picture whichever unit the story runs on.
    for (let i = 0; i < 15; i++) {
      const centred = await counter.evaluate(`(() => {
        const scroller = document.querySelector(".b-grid-body-container.b-vertical-overflow") || document.querySelector(".b-grid-body-container");
        if (!scroller) return false;
        const rows = Array.from(document.querySelectorAll(".b-grid-cell"))
          .filter((c) => /^Projector [AB]/.test((c.textContent || "").trim()))
          .map((c) => (c.closest(".b-grid-row") || c).getBoundingClientRect());
        if (rows.length < 2) {
          scroller.scrollTop += scroller.clientHeight * 0.6;
          return false;
        }
        const box = scroller.getBoundingClientRect();
        scroller.scrollTop += (Math.min(...rows.map((r) => r.top)) + Math.max(...rows.map((r) => r.bottom))) / 2 - (box.top + box.height / 2);
        return true;
      })()`);
      await counter.waitForTimeout(300);
      if (centred) break;
    }
    await counter.waitForTimeout(600);
    await move.first().hover();
    const ghost = counter.locator('.b-sch-event-wrap[data-event-id^="ghost:"]', { hasText: "Priya Patel" }).first();
    await ghost.waitFor({ timeout: 30_000 });
    await taker.shoot(counter, "schedule", {
      viewportOnly: true,
      settleMs: 1500,
      anchors: {
        heading: counter.getByRole("heading", { name: "Who has what, and when" }),
        timeline: counter.locator(".b-scheduler").first(),
        legend: counter.getByText("Agent's suggestion", { exact: true }).first(),
        repair: counter.locator(".b-sch-resource-time-range", { hasText: "Replace projector lens" }),
        proposals: proposals.first(),
        move: move.first(),
        ghost,
      },
    });
    Object.assign(manifest.facts, { scheduleFrom: from, scheduleBase: base, scheduleStrip: await modeStrip(counter), scheduleMoveTo: toUnit, scheduleDate: new Date().toISOString().slice(0, 10) });
  } finally {
    await ctx.close();
    await phoneCtx.close();
  }
}

async function insightsShots(browser: Browser, base: string, from: ShopSource, taker: ShotTaker, manifest: Manifest) {
  const ctx = await counterContext(browser, base, { ...DESK, viewport: { width: 1500, height: 1200 } });
  try {
    const page = await ctx.newPage();
    log(from === "demo" ? "insights: seeding six weeks of sample history" : "insights: the sandbox's real movements");
    await page.goto(`${base}/shop/insights`);
    await page.getByRole("heading", { name: "Where the deposit money went" }).waitFor({ timeout: 120_000 });
    for (const title of ["Held on PayPal now", "Kept this month", "Released to renters"]) {
      await page.getByText(title, { exact: true }).first().waitFor({ timeout: 90_000 });
    }
    await page.getByTestId("deposit-flow").getByText("Deposits held", { exact: true }).waitFor({ timeout: 60_000 });
    await page.getByTestId("hold-clock").getByText("72 h", { exact: true }).waitFor({ timeout: 60_000 });
    await taker.shoot(page, "insights", {
      viewportOnly: true,
      settleMs: 2500,
      anchors: {
        heading: page.getByRole("heading", { name: "Where the deposit money went" }),
        flow: page.getByTestId("deposit-flow"),
        clock: page.getByTestId("hold-clock"),
      },
    });
    Object.assign(manifest.facts, { insightsFrom: from, insightsBase: base, insightsStrip: await modeStrip(page), insightsDate: new Date().toISOString().slice(0, 10) });
  } finally {
    await ctx.close();
  }
}

/** The schedule and the dashboard, from a demo-mode server or from the live sandbox target. */
export async function captureShop(browser: Browser, base: string, from: ShopSource, taker: ShotTaker, manifest: Manifest) {
  await checkMode(base, from);
  await scheduleShots(browser, base, from, taker, manifest);
  await insightsShots(browser, base, from, taker, manifest);
}
