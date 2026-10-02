import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type Page } from "@playwright/test";
import { addDaysIso } from "@/lib/dates";

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

type Structured = Record<string, unknown> & { shop?: { today: string } };

test("an assistant books over MCP; the renter reads the mandate and approves on their phone", async ({ browser, baseURL }) => {
  // 1. The assistant, over MCP: find today's date, book, get the approval link and a status token.
  const assistant = new Client({ name: "e2e-assistant", version: "0.0.0" });
  await assistant.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await assistant.callTool({ name, arguments: args });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    return res.structuredContent as Structured;
  };
  const today = (await call("list_items")).shop!.today;
  const booking = await call("create_booking", {
    itemId: "drone-kit",
    startDate: addDaysIso(today, 1),
    endDate: addDaysIso(today, 3),
    name: "Sam Rivera",
    email: "sam@example.com",
    assistant: "Claude",
  });
  const approveUrl = String(booking.approveUrl);
  const status = async () => call("get_rental_status", { statusToken: booking.statusToken });
  expect(approveUrl).toContain("/demo/paypal?token=");
  // Nothing the assistant gets leads to the renter's page.
  expect(JSON.stringify(booking)).not.toContain("/r/");

  // 2. The renter opens the approval link, changes their mind and leaves PayPal: nothing charged,
  //    and the page PayPal cancels to has the terms but no way into the rental.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(approveUrl);
  await expect(phone.getByText("Demo stand-in for PayPal")).toBeVisible();
  await shot(phone, "a1-demo-approval");
  await phone.getByRole("link", { name: "Cancel and go back" }).click();
  await expect(phone.getByRole("heading", { name: "You left PayPal without paying" })).toBeVisible();
  expect(new URL(phone.url()).pathname).toBe("/paypal/cancelled");
  await expect(phone.getByText(/Your assistant started this booking for you/)).toBeVisible();
  await expect(phone.getByRole("heading", { name: "What you allow the shop to do" })).toBeVisible();
  await expect(phone.getByText(`sha256 ${booking.mandateSha256}`)).toBeAttached();
  expect(await phone.locator('a[href*="/r/"]').count()).toBe(0);
  await shot(phone, "a2-renter-left-paypal");
  expect((await status()).status).toBe("draft");

  // 3. They approve. PayPal sends them to their own page, the server captures the fee, and the URL is cleaned.
  await phone.getByRole("link", { name: "Review and pay $90.00 in PayPal" }).click();
  await phone.getByRole("link", { name: "Approve and pay $90.00" }).click();
  await expect(phone.getByText("Paid $90.00 with PayPal")).toBeVisible();
  const rentalPage = phone.url();
  expect(rentalPage).toMatch(/\/r\/[A-Za-z0-9_-]{24}$/);
  await expect(phone.getByText(/Your deposit mandate/)).toBeVisible();
  await shot(phone, "a3-renter-booked");

  // 4. The assistant sees the result, but the renter's page token is not a status token.
  expect(await status()).toMatchObject({ status: "booked", amounts: { feePaid: true } });
  const refused = await assistant.callTool({ name: "get_rental_status", arguments: { statusToken: rentalPage.split("/r/")[1] } });
  expect(refused.isError).toBe(true);

  // 5. Opening PayPal's return URL or the approval link again changes nothing.
  const orderId = new URL(approveUrl).searchParams.get("token");
  await phone.goto(`${rentalPage}?token=${orderId}&PayerID=DEMOPAYER`);
  expect(phone.url()).toBe(rentalPage);
  await phone.getByText("Everything that happened, step by step").click();
  await expect(phone.getByText("Rental fee paid; PayPal saved for the deposit")).toHaveCount(1);
  await expect(phone.getByText("Customer's assistant")).toBeVisible();
  await phone.goto(approveUrl);
  await expect(phone.getByRole("heading", { name: "Nothing to approve here" })).toBeVisible();
  expect(await phone.locator('a[href*="/r/"]').count()).toBe(0);
  await assistant.close();
});
