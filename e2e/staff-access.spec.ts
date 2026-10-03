import { expect, test } from "@playwright/test";
import { E2E_SHOP_ACCESS_CODE } from "./staff-code";

// Runs on its own server with SHOP_ACCESS_CODE and PUBLIC_DEMO set
// (playwright.config.ts). The renter's side needs no code; every counter page
// sends you to the sign-in page and back; a counter page left open after the
// cookie is gone cannot move money; signing out closes the counter again.

test("the counter needs the access code; the renter's side does not", async ({ browser }) => {
  const counterContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const counter = await counterContext.newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();

  // 1. The renter books with no code, as on any copy.
  await phone.goto("/rent/camera-kit");
  await phone.getByLabel("Your name").fill("Maya Chen");
  await phone.getByLabel("Email").fill("maya@example.com");
  await phone.getByRole("button", { name: /Pay \$\d+\.\d\d \(demo PayPal\)/ }).click();
  await phone.waitForURL(/\/r\//);
  await expect(phone.getByText("Paid $87.00 with PayPal")).toBeVisible();
  const rentalId = /R-[0-9A-Z]{6}/.exec((await phone.getByText(/^Rental R-/).textContent()) ?? "")![0];

  // 2. A deep link to the rental at the counter goes to the sign-in page first.
  await counter.goto(`/shop/rentals/${rentalId}`);
  await expect(counter).toHaveURL(new RegExp(`/shop/sign-in\\?next=%2Fshop%2Frentals%2F${rentalId}$`));
  await expect(counter.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
  await expect(counter.getByText("Staff only. The code is in the Devpost testing instructions.")).toBeVisible();
  expect((await counter.request.get("/api/live/shop")).status()).toBe(401);

  // 3. A wrong code is refused; the right one opens the page that was asked for.
  await counter.getByLabel("Access code").fill("not-the-code");
  await counter.getByRole("button", { name: "Open the counter" }).click();
  await expect(counter.getByText("That is not the counter's access code.")).toBeVisible();
  await counter.getByLabel("Access code").fill(E2E_SHOP_ACCESS_CODE);
  await counter.getByRole("button", { name: "Open the counter" }).click();
  await expect(counter.getByRole("heading", { name: "Pickup" })).toBeVisible();
  await expect(counter).toHaveURL(new RegExp(`/shop/rentals/${rentalId}$`));

  const [cookie] = (await counterContext.cookies()).filter((c) => c.name === "handback_staff");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookie.value).not.toContain(E2E_SHOP_ACCESS_CODE);

  // 4. Signed in, the counter works as usual.
  await counter.getByRole("button", { name: /Pickup photo/ }).click();
  await expect(counter.getByRole("button", { name: "Hold $300.00 deposit" })).toBeVisible();

  // 5. With the cookie gone, the page still on screen cannot hold the deposit: the action itself checks.
  await counterContext.clearCookies();
  await counter.getByRole("button", { name: "Hold $300.00 deposit" }).click();
  await expect(counter.getByText(/^Staff sign-in needed/)).toBeVisible();
  await expect(phone.getByText("$300.00 deposit, held at pickup")).toBeVisible();

  // 6. Sign in again from the dashboard, hold the deposit, then sign out.
  await counter.goto("/shop");
  await expect(counter).toHaveURL(/\/shop\/sign-in\?next=%2Fshop$/);
  await counter.getByLabel("Access code").fill(E2E_SHOP_ACCESS_CODE);
  await counter.getByRole("button", { name: "Open the counter" }).click();
  await expect(counter.getByRole("heading", { name: "Today at the counter" })).toBeVisible();
  await counter.getByRole("link", { name: new RegExp(rentalId) }).click();
  await counter.getByRole("button", { name: "Hold $300.00 deposit" }).click();
  await expect(counter.getByRole("heading", { name: "Return" })).toBeVisible();
  await expect(phone.getByText("$300.00 held on PayPal")).toBeVisible();

  await counter.getByRole("button", { name: "Sign out" }).click();
  await expect(counter.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
  await counter.goto("/shop/schedule");
  await expect(counter).toHaveURL(/\/shop\/sign-in\?next=%2Fshop%2Fschedule$/);
});
