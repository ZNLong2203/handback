/**
 * Screens that need a richer history than one sandbox rental, from a server
 * in demo mode (PayPal stand-in, recorded Gemini replies, sample data): the
 * schedule after a damaged return, the owner's dashboard, and the dispute
 * desk with its evidence PDF. Every page there says "demo stand-in" in its
 * mode strip, and the captions say so too.
 *
 * Run it against a fresh server: the schedule is photographed first, before
 * the dashboard's six weeks of sample history and the dispute's rental are
 * booked onto it.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser } from "@playwright/test";
import { modeStrip } from "./capture-live";
import { log, type Manifest, type ShotTaker } from "./shots";

async function scheduleShots(browser: Browser, base: string, taker: ShotTaker) {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 2 });
  const phoneCtx = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    const counter = await ctx.newPage();
    log("schedule: seeding two weeks of sample bookings");
    await counter.goto(`${base}/shop/schedule`);
    await counter.getByRole("heading", { name: "Who has what, and when" }).waitFor({ timeout: 120_000 });

    // Jordan's projector comes back with a cracked lens; Jordan accepts on a phone; the counter settles.
    log("schedule: Jordan's projector comes back with a cracked lens");
    await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Rentals" }).click();
    await counter.getByRole("link", { name: /Jordan Lee/ }).click();
    await counter.getByRole("heading", { name: "Return" }).waitFor();
    await counter.getByRole("button", { name: /Cracked lens glass/ }).click();
    await counter.getByRole("button", { name: /Compare the photos/ }).click();
    await counter.getByText("Replace projector lens").first().waitFor();
    await counter.getByRole("button", { name: /Send 1 item to Jordan/ }).click();
    const customerUrl = await counter.getByRole("link", { name: /Customer's page/ }).getAttribute("href");
    const phone = await phoneCtx.newPage();
    await phone.goto(customerUrl!);
    await phone.getByRole("button", { name: "That's fair" }).click();
    await phone.getByRole("button", { name: "Send my answers" }).click();
    await phone.getByText("Thanks. The shop is reading your answers.").waitFor();
    await counter.getByRole("button", { name: /^Keep \$160\.00/ }).click();
    await counter.getByRole("heading", { name: "Settled" }).waitFor();

    await counter.getByRole("navigation", { name: "Counter" }).getByRole("link", { name: "Schedule" }).click();
    const proposals = counter.getByTestId("proposal");
    await proposals.first().waitFor({ timeout: 60_000 });
    const move = proposals.filter({ hasText: "Move Priya Patel to Projector B" });
    // Bryntum fades the bars in after the first load.
    await counter.locator(".b-scheduler.b-initial-fade-in").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    // The timeline is 640px tall and scrolls inside; bring the projector rows into it, then point at
    // the suggestion, which draws the dashed bar where Priya's booking would go.
    await counter.evaluate(`(() => {
      const scroller = document.querySelector(".b-grid-body-container.b-vertical-overflow") || document.querySelector(".b-grid-body-container");
      const row = Array.from(document.querySelectorAll(".b-grid-row")).find((r) => (r.textContent || "").includes("Projector A"));
      if (scroller && row) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 150;
    })()`);
    await counter.waitForTimeout(600);
    await move.hover();
    await counter.locator('.b-sch-event-wrap[data-event-id^="ghost:"]', { hasText: "Priya Patel" }).first().waitFor({ timeout: 30_000 });
    await taker.shoot(counter, "schedule", {
      viewportOnly: true,
      settleMs: 1500,
      anchors: {
        heading: counter.getByRole("heading", { name: "Who has what, and when" }),
        timeline: counter.locator(".b-scheduler").first(),
        legend: counter.getByText("Agent's suggestion", { exact: true }).first(),
        repair: counter.locator(".b-sch-resource-time-range", { hasText: "Replace projector lens" }),
        proposals: proposals.first(),
        move,
        ghost: counter.locator('.b-sch-event-wrap[data-event-id^="ghost:"]', { hasText: "Priya Patel" }).first(),
      },
    });
  } finally {
    await ctx.close();
    await phoneCtx.close();
  }
}

async function insightsShots(browser: Browser, base: string, taker: ShotTaker) {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
  try {
    const page = await ctx.newPage();
    log("insights: seeding six weeks of sample history");
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
  } finally {
    await ctx.close();
  }
}

/** The city bike story to a $12.00 charge, then a dispute on it, answered with the evidence pack. */
async function disputeShots(browser: Browser, base: string, taker: ShotTaker, rawDir: string, manifest: Manifest) {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const phoneCtx = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    const phone = await phoneCtx.newPage();
    const counter = await ctx.newPage();
    log("dispute: a city bike rental settled at $12.00 in demo mode");
    await phone.goto(`${base}/rent/city-bike`);
    await phone.getByLabel("Your name").fill("An Nguyen");
    await phone.getByLabel("Email").fill("an.nguyen@example.com");
    await phone.getByRole("button", { name: /Pay \$\d+\.\d\d \(demo PayPal\)/ }).click();
    await phone.waitForURL(/\/r\//);
    const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];
    await counter.goto(`${base}/shop/rentals/${rentalId}`);
    await counter.getByRole("button", { name: /Pickup photo/ }).click();
    await counter.getByRole("button", { name: "Hold $150.00 deposit" }).click();
    await counter.getByRole("heading", { name: "Return" }).waitFor();
    await phone.getByRole("button", { name: "Yes, this is how I received it" }).click();
    await phone.getByText(/You confirmed this photo/).waitFor();
    await counter.getByRole("button", { name: /Phone holder removed, rear light removed/ }).click();
    await counter.getByRole("button", { name: /Compare the photos/ }).click();
    await counter.getByRole("button", { name: /Send 2 items to An/ }).click();
    const holder = phone.getByRole("group", { name: "Your answer for phone holder" });
    const rearLight = phone.getByRole("group", { name: "Your answer for rear light" });
    await holder.getByRole("button", { name: "That's fair" }).click();
    await rearLight.getByRole("button", { name: "I question this" }).click();
    await rearLight.getByRole("textbox").fill("It's in my backpack");
    await phone.getByRole("button", { name: "Send my answers" }).click();
    await counter.getByText("It's in my backpack").first().waitFor();
    await counter.getByRole("button", { name: "Waive it" }).click();
    await counter.getByRole("button", { name: "Keep $12.00, release $138.00" }).click();
    await counter.getByRole("heading", { name: "Settled" }).waitFor();

    log("dispute: the stand-in plays the renter's PayPal case");
    await counter.getByRole("button", { name: /customer disputes this charge/ }).click();
    const panel = counter.getByRole("region").filter({ has: counter.getByRole("button", { name: "Prepare the evidence pack" }) });
    await panel.first().waitFor({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Prepare the evidence pack" }).click();
    const open = counter.getByRole("link", { name: "Open the PDF" });
    await open.waitFor({ timeout: 60_000 });
    const href = (await open.getAttribute("href"))!;
    const pdf = await counter.request.get(new URL(href, base).toString());
    if (pdf.headers()["content-type"] !== "application/pdf") throw new Error(`evidence pack: expected a PDF, got ${pdf.headers()["content-type"]}`);
    writeFileSync(path.join(rawDir, "evidence.pdf"), await pdf.body());
    const region = counter.getByRole("region").filter({ has: open });
    await taker.shoot(counter, "dispute", {
      anchors: {
        panel: region,
        open,
        send: counter.getByRole("button", { name: "Send to PayPal" }),
        settled: counter.getByRole("heading", { name: "Settled" }),
      },
    });
    Object.assign(manifest.facts, { demoBase: base, demoDisputeRentalId: rentalId, demoStrip: await modeStrip(counter) });
  } finally {
    await ctx.close();
    await phoneCtx.close();
  }
}

export async function captureDemo(browser: Browser, base: string, taker: ShotTaker, rawDir: string, manifest: Manifest) {
  const health = (await (await fetch(`${base}/api/health`)).json()) as { paypal?: { mode?: string } };
  if (health.paypal?.mode !== "demo") throw new Error(`${base} must run in demo mode; /api/health says PayPal ${health.paypal?.mode}`);
  await scheduleShots(browser, base, taker);
  await insightsShots(browser, base, taker);
  await disputeShots(browser, base, taker, rawDir, manifest);
}
