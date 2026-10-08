/**
 * The demo video's story against a server in PayPal sandbox mode with live
 * Gemini: a city bike booked with the JS SDK v6 button (the sandbox buyer
 * approves in PayPal's popup), the deposit held on the saved wallet, two live
 * looks at the photos, the renter accepting one charge and questioning the
 * other on a phone, the counter waiving it, and one final capture.
 */
import type { Browser, Page } from "@playwright/test";
import { fillPayPalLogin, type Buyer } from "../lib/sandbox-browser";
import { log, maskPage, type Manifest, type ShotTaker } from "./shots";

const RENTER = { name: "An Nguyen", email: "an.nguyen@example.com" };

/** The booking page, reloaded until PayPal's JS SDK has drawn its button (www.sandbox.paypal.com sometimes fails to serve it). */
async function openBooking(page: Page, url: string) {
  const button = page.locator("paypal-button");
  const failed = page.getByText("PayPal could not load");
  for (let attempt = 1; ; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await button.or(failed).first().waitFor({ timeout: 90_000 });
    if (await button.isVisible()) return;
    if (attempt === 3) throw new Error("PayPal's JS SDK did not load after three tries");
    log("  PayPal's SDK did not load; reloading");
  }
}

/**
 * Signs in inside PayPal's popup, photographs the review step with the login
 * masked, then approves. The window is tall enough to show the whole review
 * page, including the sentence about saving PayPal for this shop; the small
 * card and bank pictures in the sandbox wallet are blurred, so no card
 * network's logo ends up in the gallery.
 */
async function approveWithShot(popup: Page, buyer: Buyer, taker: ShotTaker) {
  await popup.setViewportSize({ width: 460, height: 1180 });
  await popup.waitForLoadState("domcontentloaded");
  await fillPayPalLogin(popup, buyer);
  const approve = popup.getByRole("button", { name: /agree|pay now|continue|complete/i }).first();
  await approve.waitFor({ timeout: 90_000 });
  // PayPal fills in the funding sources and the consent text after the button shows.
  await popup.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await popup.waitForTimeout(1500);
  await popup.evaluate(`(() => {
    const payWith = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, span, div")).find((el) => el.textContent.trim() === "Pay with");
    const below = payWith ? payWith.getBoundingClientRect().top : 0;
    for (const img of document.querySelectorAll("img, svg")) {
      const r = img.getBoundingClientRect();
      if (r.top > below && r.width > 0 && r.width < 120 && r.height < 90) img.style.filter = "blur(7px)";
    }
  })()`);
  await maskPage(popup, [buyer.email]);
  await taker.shoot(popup, "paypal-review", { viewportOnly: true, settleMs: 800, anchors: { approve, payWith: popup.getByText("Pay with").first() } });
  for (let i = 0; i < 20 && !popup.isClosed(); i++) {
    const button = popup.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      log(`  popup: clicking "${(await button.innerText().catch(() => "?")).trim().slice(0, 40)}"`);
      await button.click().catch(() => {});
    }
    await popup.waitForTimeout(2000).catch(() => {});
  }
}

/** The strip at the top of every page that says which parts are real. */
export async function modeStrip(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The innermost element whose text starts with "PayPal:" holds only the two modes.
    const el = Array.from(document.querySelectorAll<HTMLElement>("span, div")).findLast((e) => /^PayPal:/.test(e.innerText.trim()) && e.innerText.length < 160);
    return el?.innerText.replace(/\s+/g, " ").trim() ?? "";
  });
}

/** PayPal ids from the counter page: each audit entry names the id it recorded. */
async function idsFromCounter(counter: Page) {
  const text = await counter.locator("body").innerText();
  const after = (label: RegExp, kind: string) => new RegExp(`${label.source}[\\s\\S]*?${kind} ([0-9A-Z]{17})`).exec(text)?.[1] ?? "";
  return {
    orderId: after(/PayPal order created/, "order"),
    feeCaptureId: after(/Rental fee paid/, "capture"),
    authorizationId: after(/Deposit held on PayPal/, "authorization"),
    settlementCaptureId: after(/Deposit settled/, "capture"),
  };
}

/** Live Gemini is not a replay: when the two looks do not both propose the two charges the story needs, the run starts over. */
class LooksDisagreed extends Error {
  constructor(readonly rentalId: string) {
    super(`The two looks did not both propose the phone holder and the rear light on ${rentalId} (see counter-findings-unexpected.png)`);
  }
}

export async function captureLive(browser: Browser, base: string, buyer: Buyer, taker: ShotTaker, manifest: Manifest, attempts = 2) {
  const disagreed: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      await runStory(browser, base, buyer, taker, manifest);
      // Kept for the record: rentals whose looks did not agree on both items, left with their hold open in the sandbox.
      manifest.facts.liveRentalsLooksDisagreed = disagreed.join(", ");
      return;
    } catch (err) {
      if (!(err instanceof LooksDisagreed) || attempt >= attempts) throw err;
      disagreed.push(err.rentalId);
      log(`${err.message}; starting a new rental (attempt ${attempt + 1} of ${attempts})`);
    }
  }
}

async function runStory(browser: Browser, base: string, buyer: Buyer, taker: ShotTaker, manifest: Manifest) {
  const desk = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const mobile = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    const health = (await (await desk.request.get(`${base}/api/health`)).json()) as { paypal?: { mode?: string }; ai?: { mode?: string; model?: string } };
    if (health.paypal?.mode !== "sandbox") throw new Error(`${base} must run with PayPal sandbox; /api/health says PayPal ${health.paypal?.mode}`);
    // Live Gemini, or (without GEMINI_API_KEY) the recorded two-look Gemini run of these sample photos; the captions say which.
    const ai = health.ai?.mode === "gemini" ? "gemini" : "recorded";
    log(`PayPal sandbox; AI: ${ai === "gemini" ? `live ${health.ai?.model}` : "recorded replies"}`);

    // 1. Book on a desktop browser, where PayPal opens its checkout as a popup. The renter's
    //    own page is then followed on a phone-sized screen.
    const page = await desk.newPage();
    log("booking page");
    await openBooking(page, `${base}/rent/city-bike`);
    await page.getByLabel("Your name").fill(RENTER.name);
    await page.getByLabel("Email").fill(RENTER.email);
    await page.locator("paypal-button:not([disabled])").waitFor({ timeout: 30_000 });
    await taker.shoot(page, "book-desktop", { anchors: { cancel: page.getByText(/If you cancel before pickup/i) } });
    log("clicking the PayPal button");
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 60_000 }), page.locator("paypal-button").click()]);
    await approveWithShot(popup, buyer, taker);
    await page.waitForURL(/\/r\//, { timeout: 90_000 });
    await page.getByText(/Paid \$45\.00 with PayPal/).waitFor({ timeout: 60_000 });
    const renterUrl = page.url().split("?")[0];
    const rentalId = /R-[0-9A-Z]{6}/.exec((await page.getByText(/^Rental R-/).textContent()) ?? "")![0];
    log(`booked ${rentalId}`);
    await page.close();

    const phone = await mobile.newPage();
    await phone.goto(renterUrl);
    await phone.getByText(/Paid \$45\.00 with PayPal/).waitFor();

    // 2. Pick up: the counter photographs the bike and holds the deposit on the saved wallet.
    const counter = await desk.newPage();
    await counter.goto(`${base}/shop/rentals/${rentalId}`);
    await counter.getByRole("heading", { name: "Pickup" }).waitFor();
    log("pickup photo + hold on the saved wallet");
    await counter.getByRole("button", { name: /Pickup photo/ }).click();
    await counter.getByRole("button", { name: "Hold $150.00 deposit" }).waitFor();
    await taker.shoot(counter, "counter-pickup", {
      anchors: { pickup: counter.getByRole("heading", { name: "Pickup" }), hold: counter.getByRole("button", { name: "Hold $150.00 deposit" }) },
    });
    await counter.getByRole("button", { name: "Hold $150.00 deposit" }).click();
    await counter.getByRole("heading", { name: "Return" }).waitFor({ timeout: 90_000 });

    await phone.getByText("$150.00 held on PayPal").first().waitFor({ timeout: 30_000 });
    await phone.getByRole("button", { name: "Yes, this is how I received it" }).waitFor();
    await taker.shoot(phone, "renter-confirm", {
      anchors: { confirm: phone.getByRole("button", { name: "Yes, this is how I received it" }) },
    });
    await phone.getByRole("button", { name: "Yes, this is how I received it" }).click();
    await phone.getByText(/You confirmed this photo/).waitFor();

    // 3. Return: two Gemini looks, live or recorded.
    log(`return photo: phone holder and rear light gone; two ${ai === "gemini" ? "live Gemini looks" : "recorded Gemini looks"}`);
    await counter.getByRole("button", { name: /Phone holder removed, rear light removed/ }).click();
    await counter.getByRole("button", { name: /Compare the photos/ }).click();
    await counter.getByRole("heading", { name: "What the photos show" }).waitFor({ timeout: 180_000 });
    const send = counter.getByRole("button", { name: /Send 2 items to An/ });
    const both = (await counter.getByText("Replace phone holder").count()) > 0 && (await counter.getByText("Replace rear light").count()) > 0;
    if (!both || !(await send.isVisible().catch(() => false))) {
      await taker.shoot(counter, "counter-findings-unexpected");
      throw new LooksDisagreed(rentalId);
    }
    await taker.shoot(counter, "counter-findings", {
      anchors: {
        section: counter.getByRole("heading", { name: "What the photos show" }),
        proposed: counter.getByText(/^Proposed: keep/).first(),
      },
    });

    // 4. Review on the phone: accept the phone holder, question the rear light.
    await send.click();
    await phone.getByRole("heading", { name: "Please review what the shop found" }).waitFor({ timeout: 30_000 });
    const holder = phone.getByRole("group", { name: "Your answer for phone holder" });
    const rearLight = phone.getByRole("group", { name: "Your answer for rear light" });
    await holder.getByRole("button", { name: "That's fair" }).click();
    await rearLight.getByRole("button", { name: "I question this" }).click();
    await rearLight.getByRole("textbox").fill("It's in my backpack");
    await taker.shoot(phone, "renter-answers", {
      anchors: { sendAnswers: phone.getByRole("button", { name: "Send my answers" }) },
    });
    await phone.getByRole("button", { name: "Send my answers" }).click();
    await phone.getByText("Thanks. The shop is reading your answers.").waitFor({ timeout: 30_000 });

    // 5. The counter reads the note and waives the rear light, then settles.
    await counter.getByText("It's in my backpack").first().waitFor({ timeout: 30_000 });
    await taker.shoot(counter, "counter-questioned", {
      anchors: {
        waive: counter.getByRole("button", { name: "Waive it" }),
        lightPrice: counter.getByText("Replace rear light").first(),
      },
    });
    await counter.getByRole("button", { name: "Waive it" }).click();
    const settle = counter.getByRole("button", { name: "Keep $12.00, release $138.00" });
    await settle.waitFor({ timeout: 30_000 });
    log("settling: one final capture");
    await settle.click();
    await counter.getByRole("heading", { name: "Settled" }).waitFor({ timeout: 90_000 });
    await taker.shoot(counter, "counter-settled", {
      settleMs: 2200,
      anchors: {
        settled: counter.getByRole("heading", { name: "Settled" }),
        refunds: counter.getByRole("heading", { name: "Refunds" }),
        lightPrice: counter.getByText("Replace rear light").first(),
      },
    });

    await phone.getByText("Deposit released to your PayPal").waitFor({ timeout: 30_000 });
    await taker.shoot(phone, "renter-receipt", {
      settleMs: 2200,
      anchors: { released: phone.getByText("Deposit released to your PayPal") },
    });

    const ids = await idsFromCounter(counter);
    if (Object.values(ids).some((id) => !id)) throw new Error(`could not read every PayPal id from ${rentalId}'s audit trail: ${JSON.stringify(ids)}`);
    const strip = await modeStrip(counter);
    Object.assign(manifest.facts, {
      liveBase: base,
      liveRentalId: rentalId,
      liveOrderId: ids.orderId,
      liveFeeCaptureId: ids.feeCaptureId,
      liveAuthorizationId: ids.authorizationId,
      liveSettlementCaptureId: ids.settlementCaptureId,
      liveAi: ai,
      liveStrip: strip,
      liveDate: new Date().toISOString().slice(0, 10),
    });
    log(`sandbox ids: ${JSON.stringify(ids)}`);
  } finally {
    await desk.close();
    await mobile.close();
  }
}
