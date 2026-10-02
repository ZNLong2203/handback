/**
 * Drives the real app against the PayPal sandbox and live Gemini: the JS SDK
 * v6 button, the sandbox buyer's popup approval, the saved-wallet deposit
 * hold, the two-look comparison and the final capture. Needs the dev server
 * running with sandbox credentials (npm run dev) and the sandbox buyer login
 * in .env.local.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/sandbox-walkthrough.ts [--headed]
 */
import { chromium, type Page } from "@playwright/test";
import { bookAndSettle, sandboxBuyer } from "./lib/sandbox-browser";

const BASE = process.env.WALKTHROUGH_URL ?? "http://localhost:3000";
const OUT = process.env.WALKTHROUGH_SHOTS;
const buyer = sandboxBuyer();

const shot = async (page: Page, name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};

const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
try {
  await bookAndSettle(context, BASE, buyer, shot);
} finally {
  await browser.close();
}
