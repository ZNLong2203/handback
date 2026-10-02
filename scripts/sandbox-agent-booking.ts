/**
 * Checks the assistant path against the real PayPal sandbox: books over MCP
 * (no model involved, so every run is the same), opens PayPal's payer-action
 * link as the sandbox buyer, approves, and confirms that PayPal's redirect
 * back to the rental page captured the booking. Needs the app running in
 * sandbox mode with APP_URL pointing at it, and the sandbox buyer login in
 * .env.local.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/sandbox-agent-booking.ts [--rental <statusToken>] [--cancel-first] [--early-return] [--headed]
 *
 * --rental <tok>  approve a booking an assistant already made (its statusToken), e.g. from agent-books.ts
 * --cancel-first  leave PayPal once through its cancel link before approving
 * --early-return  open the return URL with a made-up PayerID before approving;
 *                 the script reads the renter's page link off the counter,
 *                 since the assistant is never given it
 * --settle        then run the rental to the end at the counter (drone kit only):
 *                 deposit hold, a return with a battery missing, live Gemini,
 *                 the renter's answer on their page, final capture
 */
import { chromium, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.WALKTHROUGH_SHOTS;
const buyer = { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "", password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? "" };
if (!buyer.email || !buyer.password) throw new Error("Set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD");
const flag = (name: string) => process.argv.includes(name);
const step = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

const mcp = new Client({ name: "sandbox-agent-check", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`)));
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function book() {
  const existing = process.argv[process.argv.indexOf("--rental") + 1];
  if (flag("--rental") && existing) {
    const status = await call("get_rental_status", { statusToken: existing });
    if (!status.approveUrl) throw new Error(`rental ${status.rentalId} is ${status.status}, not waiting for approval`);
    return { rentalId: status.rentalId, approveUrl: status.approveUrl, statusToken: existing, payNow: status.amounts.fee };
  }
  const { shop } = await call("list_items");
  const day = (n: number) => new Date(Date.parse(`${shop.today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return call("create_booking", {
    itemId: "drone-kit",
    startDate: day(1),
    endDate: day(3),
    name: "Sam Rivera",
    email: "sam@example.com",
    assistant: "sandbox check script",
  });
}

const booking = await book();
const status = () => call("get_rental_status", { statusToken: booking.statusToken });
const orderId = new URL(booking.approveUrl).searchParams.get("token");
step(`${flag("--rental") ? "approving" : "booked"} ${booking.rentalId}: order ${orderId}, ${booking.payNow.usd} to approve`);
step(`approve link: ${booking.approveUrl}`);
if (!booking.approveUrl.startsWith("https://www.sandbox.paypal.com/")) throw new Error("not a sandbox payer-action link; is the app in sandbox mode?");

const browser = await chromium.launch({ headless: !flag("--headed") });
const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })).newPage();
// Every navigation PayPal makes back to the app, with the query it appended.
const returns: string[] = [];
page.on("request", (r) => {
  if (r.isNavigationRequest() && r.url().startsWith(`${BASE}/`)) returns.push(r.url());
});
/** The renter's page: PayPal opens it after approval; before that only the counter shows its link. */
let rentalPageUrl = "";

/** Reads the renter's page link off the counter, as staff would show it to them. */
async function renterPageFromCounter(): Promise<string> {
  const counter = await page.context().newPage();
  await counter.goto(`${BASE}/shop/rentals/${booking.rentalId}`);
  const href = await counter.getByRole("link", { name: "Customer's page" }).getAttribute("href");
  await counter.close();
  if (!href) throw new Error("the counter shows no link to the renter's page");
  return href;
}

/** The rest of the rental at the counter, with the renter answering on their own page. */
async function settle() {
  const counter = await page.context().newPage();
  await counter.goto(`${BASE}/shop/rentals/${booking.rentalId}`);
  step("counter: pickup photo, then the deposit hold on the saved wallet");
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await counter.getByRole("button", { name: /^Hold \$[\d,.]+ deposit$/ }).click();
  await counter.getByRole("heading", { name: "Return" }).waitFor({ timeout: 60_000 });
  let now = await status();
  step(`  over MCP: ${now.status}, held ${now.amounts.heldNow?.usd}`);

  await page.goto(rentalPageUrl);
  await page.getByRole("button", { name: "Yes, this is how I received it" }).click();
  await page.getByText(/You confirmed this photo/).waitFor();
  step("counter: return photo with one battery missing; two live Gemini looks");
  await counter.getByRole("button", { name: /One of two batteries removed/ }).click();
  await counter.getByRole("button", { name: /Compare the photos/ }).click();
  await counter.getByRole("heading", { name: "What the photos show" }).waitFor({ timeout: 120_000 });
  const send = counter.getByRole("button", { name: /Send \d item/ });
  if (await send.isVisible().catch(() => false)) {
    await send.click();
    await page.getByRole("heading", { name: "Please review what the shop found" }).waitFor({ timeout: 30_000 });
    now = await status();
    const waiting = now.waitingForRenter.map((f: { charge: string; price: { usd: string } }) => `${f.charge} ${f.price.usd}`);
    step(`  over MCP: ${now.status}, waiting for the renter: ${waiting.join(", ")}`);
    for (const fair of await page.getByRole("button", { name: "That's fair" }).all()) await fair.click();
    await page.getByRole("button", { name: "Send my answers" }).click();
    await page.getByText("Thanks. The shop is reading your answers.").waitFor({ timeout: 30_000 });
    await counter.getByRole("button", { name: /^Keep \$/ }).click();
  } else {
    step("  nothing to charge");
    await counter.getByRole("button", { name: /Release the whole/ }).click();
  }
  await counter.getByRole("heading", { name: "Settled" }).waitFor({ timeout: 60_000 });
  const ids = (await counter.locator("dl.font-mono").innerText()).replace(/\s+/g, " ");
  now = await status();
  step(`settled on PayPal (${ids}); over MCP: kept ${now.amounts.kept.usd}, released ${now.amounts.released.usd}`);
  await shot(counter, "s1-counter-settled");
}

/** Logs in as the sandbox buyer unless PayPal already shows the review page. */
async function logIn() {
  const email = page.locator('input#email, input[name="login_email"]');
  const review = page.getByRole("button", { name: /agree|pay now|continue/i });
  await email.or(review).first().waitFor({ timeout: 60_000 });
  if (!(await email.first().isVisible())) {
    step("  PayPal skipped the login form");
    return;
  }
  step("  logging in as the sandbox buyer");
  await email.first().fill(buyer.email);
  const next = page.locator("#btnNext");
  if (await next.isVisible().catch(() => false)) await next.click();
  const password = page.locator('input#password, input[name="login_password"]');
  await password.first().waitFor({ timeout: 30_000 });
  await password.first().fill(buyer.password);
  await page.locator("#btnLogin").click();
}

try {
  if (flag("--early-return")) {
    step("opening the return URL with a made-up PayerID, before any approval");
    const renterPage = await renterPageFromCounter();
    await page.goto(`${renterPage}?token=${orderId}&PayerID=NOTAPPROVED1`);
    const notice = await page.getByText("PayPal did not complete the payment").locator("..").innerText();
    step(`  page says: ${notice.replace(/\s+/g, " ")}`);
    step(`  status over MCP: ${(await status()).status}`);
  }

  if (flag("--cancel-first")) {
    step("opening PayPal, then its cancel link");
    await page.goto(booking.approveUrl, { waitUntil: "domcontentloaded" });
    await logIn();
    const cancel = page.getByText(/Cancel and return to/i).first();
    await cancel.waitFor({ timeout: 60_000 });
    await shot(page, "c1-paypal-review");
    await cancel.click();
    await page.getByRole("heading", { name: "You left PayPal without paying" }).waitFor({ timeout: 60_000 });
    step(`  PayPal sent the buyer to ${returns.at(-1)}`);
    await shot(page, "c2-renter-cancelled");
  }

  step("opening PayPal as the sandbox buyer");
  await page.goto(booking.approveUrl, { waitUntil: "domcontentloaded" });
  await logIn();
  for (let i = 0; i < 20 && !page.url().startsWith(BASE); i++) {
    const button = page.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      await shot(page, `p1-paypal-approve-${i}`);
      step(`  clicking "${(await button.innerText().catch(() => "?")).trim().slice(0, 40)}"`);
      await button.click().catch(() => {});
    }
    await page.waitForTimeout(2500);
  }
  await page.getByText(/Paid \$\d+\.\d\d with PayPal/).waitFor({ timeout: 90_000 });
  const approvedReturn = returns.filter((u) => u.includes("PayerID=")).at(-1);
  rentalPageUrl = page.url();
  step(`  PayPal sent the buyer to ${approvedReturn}`);
  step(`  landed on ${rentalPageUrl}`);
  await shot(page, "p2-renter-booked");

  await page.getByText("Everything that happened, step by step").click();
  const timeline = await page.locator("ol").last().innerText();
  const capture = /capture ([A-Z0-9]{17})/.exec(timeline)?.[1];
  const refused = timeline.match(/PayPal refused a step[\s\S]*?debug_id \S+/g) ?? [];
  const booked = await status();
  step(`booked: order ${orderId}, fee capture ${capture}, status over MCP "${booked.status}", fee paid ${booked.amounts.feePaid}`);
  for (const r of refused) step(`  audit log: ${r.replace(/\s+/g, " ")}`);

  if (flag("--settle")) await settle();
} finally {
  await browser.close();
  await mcp.close();
}
