/**
 * The dispute desk with its evidence PDF, from a server in demo mode (PayPal
 * stand-in, recorded Gemini replies). A sandbox dispute needs the buyer to
 * file a case in PayPal's Resolution Center first (scripts/spike-dispute.ts
 * does that), which this generator does not do, so this slide stays a demo
 * capture wherever the others come from. Every page there says "demo
 * stand-in" in its mode strip, and the captions say so too. (The schedule
 * and the dashboard are in capture-shop.ts.)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser } from "@playwright/test";
import { modeStrip } from "./capture-live";
import { log, type Manifest, type ShotTaker } from "./shots";
import { counterContext } from "./staff";

/** The city bike story to a $12.00 charge, then a dispute on it, answered with the evidence pack. */
async function disputeShots(browser: Browser, base: string, taker: ShotTaker, rawDir: string, manifest: Manifest) {
  const ctx = await counterContext(browser, base, { locale: "en-US", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
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
  await disputeShots(browser, base, taker, rawDir, manifest);
}
