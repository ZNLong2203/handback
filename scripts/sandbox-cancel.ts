/**
 * Cancels a paid booking in the PayPal sandbox through the app's own code,
 * on the app's database, and reads PayPal back:
 *   1. startBooking creates the sandbox order; the sandbox buyer approves it
 *      on PayPal's payer-action page in a headless browser;
 *   2. returnFromPayPal captures the fee, as the renter's page does when
 *      PayPal sends them back (the redirect is intercepted, so no app server
 *      needs to run);
 *   3. cancelAsRenter refunds what the cancellation policy gives back now
 *      (pickup tomorrow: the day before pickup, so half the fee);
 *   4. the same cancel pressed again: answered from the app's record, no PayPal call;
 *   5. the same refund sent to PayPal again with the same PayPal-Request-Id;
 *   6. the counter refunds the rest of the fee (refundCharge, refund number 2);
 *   7. GET the refunds and the capture back.
 * With PGlite (no DATABASE_URL), stop the dev server first: one process at a time.
 *   APP_URL=http://localhost:3399 npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/sandbox-cancel.ts [--headed]
 */
import { chromium } from "@playwright/test";
import { addDaysIso, todayIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { depositGateway } from "@/lib/paypal";
import { paypalRequest } from "@/lib/paypal/rest";
import { cancelAsRenter, quoteCancellation } from "@/lib/rentals/cancel";
import { feeCapture, refundCharge, refundInvoiceId, refundRequestId, refundsFor } from "@/lib/rentals/refunds";
import { eventsFor, rentalById } from "@/lib/rentals/repo";
import { returnFromPayPal, startBooking } from "@/lib/rentals/service";
import { appUrl } from "@/lib/shop";
import { fillPayPalLogin, sandboxBuyer, step } from "./lib/sandbox-browser";

const gateway = depositGateway();
if (gateway.mode !== "sandbox") throw new Error(`PayPal is in ${gateway.mode} mode; this script only runs against the sandbox.`);
const buyer = sandboxBuyer();
const BASE = appUrl();
const log = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);
const db = await getDb();

// 1. Book the action camera kit from tomorrow: the sandbox order for the fee.
const today = todayIso();
const booking = await startBooking({ itemId: "action-cam-kit", name: "Lena Park", email: "lena@example.com", startDate: addDaysIso(today, 1), endDate: addDaysIso(today, 3) });
log("1. startBooking", { rentalId: booking.rentalId, orderId: booking.orderId, approveUrl: booking.approveUrl, mandateVersion: booking.mandate.version });
if (!booking.approveUrl?.startsWith("https://www.sandbox.paypal.com/")) throw new Error("not a sandbox payer-action link");

const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
let back: URL | null = null;
try {
  const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })).newPage();
  // PayPal sends the buyer back to the renter's page; answer it here instead of an app server.
  await page.route(`${BASE}/**`, async (route) => {
    back = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>back from PayPal</p>" });
  });
  step("opening PayPal's approval page as the sandbox buyer");
  await page.goto(booking.approveUrl, { waitUntil: "commit", timeout: 90_000 });
  const email = page.locator('input#email, input[name="login_email"]');
  const review = page.getByRole("button", { name: /agree|pay now|continue/i });
  await email.or(review).first().waitFor({ timeout: 90_000 });
  if (await email.first().isVisible()) await fillPayPalLogin(page, buyer);
  for (let i = 0; i < 25 && !back; i++) {
    const button = page.getByRole("button", { name: /agree|continue|pay|complete|save/i }).first();
    if (await button.isVisible().catch(() => false)) {
      step(`  clicking "${(await button.innerText().catch(() => "?")).trim().slice(0, 40)}"`);
      await button.click().catch(() => {});
    }
    await page.waitForTimeout(2500);
  }
} finally {
  await browser.close();
}
if (!back) throw new Error("PayPal never sent the buyer back");
const returned = back as URL;
const query = { token: returned.searchParams.get("token") ?? undefined, PayerID: returned.searchParams.get("PayerID") ?? undefined };
log("PayPal sent the buyer back to", { path: returned.pathname, token: query.token, PayerID: query.PayerID });

// 2. Capture the fee, as the renter's page does.
const outcome = await returnFromPayPal(booking.token, query);
let rental = (await rentalById(db, booking.rentalId))!;
log("2. returnFromPayPal", { outcome, status: rental.status, feeCaptureId: rental.feeCaptureId, feeCents: rental.feeCents, savedWallet: Boolean(rental.vaultId) });
if (rental.status !== "booked") throw new Error("the booking was not captured");

// 3. The renter cancels: the page shows what the policy gives back now, and sends that amount.
const before = feeCapture(rental, await refundsFor(db, rental.id));
const quote = quoteCancellation(rental, { feeLeftCents: before?.leftCents ?? 0, openDispute: false, events: await eventsFor(db, rental.id) }, "renter", new Date());
log("3a. what the renter's page shows", { percent: quote.policy.percent, refundCents: quote.refundCents, until: quote.policy.until, terms: quote.terms });
const shown = { paid: quote.paid, refundCents: quote.refundCents };
const cancelled = await cancelAsRenter(booking.token, shown);
rental = (await rentalById(db, booking.rentalId))!;
log("3b. cancelAsRenter", { result: cancelled, status: rental.status, cancelRefundCents: rental.cancelRefundCents, requestId: refundRequestId(rental.id, 1) });

// 4. Pressed again.
log("4. cancelAsRenter again (answered from the app's record)", await cancelAsRenter(booking.token, shown));

// 5. The same refund request to PayPal again, same PayPal-Request-Id.
const first = cancelled.refund!;
const replay = await gateway.refund(
  { captureId: rental.feeCaptureId!, amountCents: first.amountCents, noteToPayer: first.reason ?? "", invoiceId: refundInvoiceId(rental.id, 1) },
  refundRequestId(rental.id, 1),
);
log("5. PayPal, same PayPal-Request-Id", { ...replay, sameRefund: replay.refundId === first.refundId });

// 6. The counter gives back the rest of the fee.
const left = feeCapture(rental, await refundsFor(db, rental.id))!;
const rest = await refundCharge(rental.id, { captureId: left.captureId, cents: left.leftCents, reason: "The rest of your fee back, as a courtesy", seq: 2 });
log("6. refundCharge on the fee of the cancelled booking", { seq: rest.seq, refundId: rest.refundId, amountCents: rest.amountCents, paypalStatus: rest.paypalStatus });

// 7. Read PayPal back.
for (const r of await refundsFor(db, rental.id)) {
  const got = await paypalRequest<Record<string, unknown>>("GET", `/v2/payments/refunds/${r.refundId}`);
  log(`7a. GET /v2/payments/refunds/${r.refundId}`, { debugId: got.debugId, status: got.data.status, amount: got.data.amount, invoice_id: got.data.invoice_id, note_to_payer: got.data.note_to_payer });
}
const capture = await paypalRequest<Record<string, unknown>>("GET", `/v2/payments/captures/${rental.feeCaptureId}`);
log("7b. GET /v2/payments/captures/{fee capture}", { debugId: capture.debugId, id: capture.data.id, status: capture.data.status, amount: capture.data.amount });
log(
  "audit entries",
  (await eventsFor(db, rental.id)).map((e) => ({ type: e.type, data: e.data })),
);
process.exit(0);
