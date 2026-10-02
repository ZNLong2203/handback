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
  // 1. The assistant, over MCP: find today's date, book, get the links.
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
  const rentalPageUrl = String(booking.rentalPageUrl);
  expect(String(booking.approveUrl)).toContain("/demo/paypal?token=");

  // 2. The renter opens their page: unpaid, with the mandate they are about to agree to.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(rentalPageUrl);
  await expect(phone.getByRole("heading", { name: "Approve the booking in PayPal" })).toBeVisible();
  await expect(phone.getByText(/Your assistant started this booking for you/)).toBeVisible();
  await expect(phone.getByRole("heading", { name: "What you allow the shop to do" })).toBeVisible();
  await expect(phone.getByText(`sha256 ${booking.mandateSha256}`)).toBeAttached();
  await shot(phone, "a1-renter-draft");

  // 3. They go to PayPal, change their mind, and come back: nothing charged.
  await phone.getByRole("link", { name: "Review and pay $90.00 in PayPal" }).click();
  await expect(phone.getByText("Demo stand-in for PayPal")).toBeVisible();
  await shot(phone, "a2-demo-approval");
  await phone.getByRole("link", { name: "Cancel and go back" }).click();
  await expect(phone.getByText("You left PayPal without paying")).toBeVisible();
  expect((await call("get_rental_status", { token: rentalPageUrl })).status).toBe("draft");

  // 4. They approve. PayPal sends them back, the server captures the fee, and the URL is cleaned.
  await phone.getByRole("link", { name: "Review and pay $90.00 in PayPal" }).click();
  await phone.getByRole("link", { name: "Approve and pay $90.00" }).click();
  await expect(phone.getByText("Paid $90.00 with PayPal")).toBeVisible();
  expect(phone.url()).toBe(rentalPageUrl);
  await expect(phone.getByText(/Your deposit mandate/)).toBeVisible();
  await shot(phone, "a3-renter-booked");

  // 5. The assistant sees the result, and opening PayPal's return URL again changes nothing.
  expect(await call("get_rental_status", { token: rentalPageUrl })).toMatchObject({ status: "booked", amounts: { feePaid: true } });
  const orderId = new URL(String(booking.approveUrl)).searchParams.get("token");
  await phone.goto(`${rentalPageUrl}?token=${orderId}&PayerID=DEMOPAYER`);
  expect(phone.url()).toBe(rentalPageUrl);
  await phone.getByText("Everything that happened, step by step").click();
  await expect(phone.getByText("Rental fee paid; PayPal saved for the deposit")).toHaveCount(1);
  await expect(phone.getByText("Customer's assistant")).toBeVisible();
  await assistant.close();
});
