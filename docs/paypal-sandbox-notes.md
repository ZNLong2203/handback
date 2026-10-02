# PayPal sandbox notes

Behaviour verified against the PayPal sandbox (`api-m.sandbox.paypal.com`) before building on it. Each line is something the deposit flow depends on.

## 2026-10-02: authorize, capture, void, reauthorize, refund

Setup: Orders v2 with `intent: AUTHORIZE` and a sandbox test card as `payment_source.card`, so the authorization completes without a buyer approval step. Every POST sent a fresh `PayPal-Request-Id`.

| # | What we tried | Result |
|---|---|---|
| 1 | Authorize $380 (rental fee $80 + deposit $300) | Order `COMPLETED`, authorization `CREATED`, `expiration_time` 29 days out |
| 2 | Capture $125 (fee + one damage charge) with `final_capture: true` | Capture `COMPLETED`; authorization becomes `CAPTURED`; the unused $255 is released |
| 3 | No damage: capture only the $80 fee with `final_capture: true` | Capture `COMPLETED` |
| 4 | Booking cancelled: `void` the whole authorization | `VOIDED` |
| 5 | Capture $80 with `final_capture: false`, then `void` | Capture `COMPLETED`, then the remainder `VOIDED` |
| 6 | Capture $130 against a $100 authorization | `422 MAX_CAPTURE_AMOUNT_EXCEEDED` |
| 7 | `reauthorize` on the day of the original authorization | `422 REAUTHORIZATION_TOO_SOON`: "only allowed once from Day 4 to Day 29 since the date of the original authorization" |
| 8 | Refund $40 of a $150 capture | Refund `COMPLETED` |

Design consequences:

- Settlement is a single capture of fee plus approved damage with `final_capture: true`. PayPal releases the rest; no separate void is needed.
- The settlement amount is clamped to the authorized amount before calling PayPal. Damage above the deposit is collected separately (saved PayPal via Vault, or an invoice), never by over-capturing.
- The reauthorization job runs on day 4 of a rental, not before the 3-day honor period ends, and runs at most once per authorization.

## 2026-10-02: save PayPal at booking, hold the deposit at pickup

The deposit should start its 29-day validity when the item leaves the shop, not when the booking is made, so the flow was changed and re-verified. `scripts/spike-vault.ts` approves the sandbox buyer's checkout with Playwright, then runs every later step through the API with no buyer present.

| # | What we tried | Result |
|---|---|---|
| 1 | Booking: Orders v2 `intent: CAPTURE` for the $80 fee with `payment_source.paypal.attributes.vault` (`store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`, `customer_type: CONSUMER`) | `PAYER_ACTION_REQUIRED`; the buyer sees "Agree & Pay Now" |
| 2 | Capture the booking order after approval | `COMPLETED`; `payment_source.paypal.attributes.vault` returns a payment token with `status: VAULTED` and a customer id |
| 3 | Pickup: `intent: AUTHORIZE` for the $300 deposit with `payment_source.paypal.vault_id`, buyer not present | Order `COMPLETED` immediately; authorization `CREATED` with a 29-day `expiration_time` |
| 4 | Return: capture $45 of that authorization with `final_capture: true` | `COMPLETED` |
| 5 | Damage above the deposit: `intent: CAPTURE` with the same `vault_id` | `COMPLETED` |

Design consequences:

- One buyer approval at booking covers the fee, consent to the deposit, and later charges. The deposit hold, settlement and any overage need no further buyer action, so pickup and return are one tap for staff.
- The vault token belongs to this merchant only. That fits Handback, where the shop is always the merchant of record.

Setup gotcha: sandbox buyer passwords often contain `#`. Node's `--env-file` and Next.js both treat an unquoted `#` as the start of a comment, which silently truncates the password and makes the sandbox login fail with "Some of your info isn't correct". Wrap such values in single quotes.

## 2026-10-02: the whole app against the sandbox

`scripts/sandbox-walkthrough.ts` drives the running app in a browser: it clicks the JS SDK v6 PayPal button, approves the payment as the sandbox buyer in PayPal's popup, then runs the counter flow with live Gemini. One run, start to finish in about 33 seconds:

| Step | PayPal result |
|---|---|
| Booking: v6 button (`savePayment`), buyer approves "Agree & Pay Now" | order `0HL96236BY116954N`, fee capture `88W11018NV496100U`, wallet vaulted |
| Pickup: deposit held on the saved wallet, buyer not present | authorization `00T82573RL225500P`, $300.00, expires in 29 days |
| Return: two live `gemini-3.8-flash` looks, 5.6 s, both report the missing lens hood | proposal: $35.00 from the price list |
| Customer accepts on their page; counter settles | capture `27E47755F4775162P`: $35.00 kept, $265.00 released |

## 2026-10-02: an assistant's booking, approved by redirect

An assistant books over the MCP endpoint (`docs/agents.md`) and hands the person PayPal's `payer-action` link, so there is no JS SDK button: the buyer approves on PayPal's site and PayPal redirects back. The booking order is the same Orders v2 `intent: CAPTURE` order with vault attributes as above, with `experience_context.return_url` set to the renter's page and `cancel_url` to the same page plus `?paypal=cancelled` (changed later the same day; see below). `scripts/sandbox-agent-booking.ts` books over MCP (no model involved) and drives the link as the sandbox buyer in a browser.

| # | What we tried | Result |
|---|---|---|
| 1 | `create_booking` over MCP | Order `80U65911EF3853831`, `PAYER_ACTION_REQUIRED`, `payer-action` link `https://www.sandbox.paypal.com/checkoutnow?token=80U65911EF3853831` |
| 2 | Open the return URL with a made-up `PayerID` before approving | Capture refused with `422 ORDER_NOT_APPROVED` (debug_id `f2313288a59f2`); the page shows it and the rental stays unpaid |
| 3 | Log in, then follow PayPal's "Cancel and return" link | PayPal sends the buyer to `cancel_url` with `&token=80U65911EF3853831` added to our own query |
| 4 | Open the link again and click "Agree & Pay Now" | PayPal sends the buyer to `return_url?token=80U65911EF3853831&PayerID=QJUL8ARAJ5X86&ba_token=BA-6M203637MU6336721` |
| 5 | The page captures, with the same `PayPal-Request-Id` as the refused attempt in row 2 | `COMPLETED`, capture `4LX3105906853610N`; `get_rental_status` reports `booked` |
| 6 | Gemini books from "rent a drone this weekend for Sam, sam@example.com" (`npm run agent:book`), then the buyer approves its link | Order `7PN16640LG248603E`, capture `2XN89951BX6742945` |
| 7 | A booking made over MCP, run to the end at the counter (`--settle`) | Order `21D35655UX748484E`, fee capture `6A406398398499346`; deposit authorization `6YT7084949567703S` for $300.00 on the saved wallet; live Gemini proposes "Replace flight battery" at $89.00; the renter accepts on their page; final capture `0T4182587S945703Y`: $89.00 kept, $211.00 released |

Design consequences:

- The return handler acts only when `token` matches the rental's order id and a `PayerID` is present. It ignores `ba_token`, which PayPal adds because the order saves the wallet.
- PayPal did not replay the refusal for the reused `PayPal-Request-Id`: once the buyer had approved, the capture with that id went through (seen in three runs). So a return URL opened too early, by the renter or anyone holding the link, does not block the real approval.
- A forged return cannot move money: PayPal will not capture an order the buyer has not approved.
- The first run of row 2 found a bug: the page answered 500 instead of showing PayPal's refusal. The MCP route had created the shared gateway, and Next.js gives route handlers and pages separate copies of `lib/paypal/errors.ts`, so the page's `instanceof PayPalError` check failed. Errors now carry a `Symbol.for` brand checked by `PayPalError.is()`.

A later run of all three options in one go, against the production build (`next start`), matched: order `5EN77778JK710894B`, early-return refusal debug_id `ca44245ae4b34`, fee capture `1NM41915M7482094K`, deposit authorization `06944361YF840141F`, final capture `68V25968GR105344W` ($89.00 kept, $211.00 released).

Run: start the app in sandbox mode with `APP_URL` set to its address, then `npx tsx --env-file-if-exists=.env.local scripts/sandbox-agent-booking.ts --early-return --cancel-first`, or `--rental <statusToken>` to approve a booking an assistant made, or `--settle` to run it to the end.

### Later the same day: a cancel URL without the renter's token

A review pointed out that the assistant was handed the renter's page, which can answer charges. The assistant now gets a read-only status token instead, but PayPal's cancel URL was still the renter's page, so we checked whether the approval link alone leads there.

| # | What we tried | Result |
|---|---|---|
| 8 | Open a fresh approval link and follow PayPal's "Cancel and return to Kestrel Camera Rentals" link without logging in (PayPal showed its login page in Vietnamese for our IP) | The link is on the login page, before any login. Order `4PU12187XF233152H`; PayPal sent the browser to the cancel URL, now `/paypal/cancelled?token=4PU12187XF233152H`. With the old cancel URL this would have been the renter's page |
| 9 | The whole check with `--early-return --cancel-first`, with `cancel_url` now `/paypal/cancelled` | Order `2J749778E6617882E`; forged return refused with `ORDER_NOT_APPROVED` (debug_id `f316136059281`); cancel landed on `/paypal/cancelled?token=2J749778E6617882E`, which links nowhere under `/r/`; approval landed on `/r/<token>?token=2J749778E6617882E&PayerID=QJUL8ARAJ5X86&ba_token=…`; fee capture `0RE56553LL1689021` |

Design consequences:

- Anyone holding the approval link can reach the cancel URL, so it carries no rental token. Only an approval, which takes the payer's PayPal login, reaches the return URL and the renter's page.
- In headless Chromium, PayPal's checkout page sometimes did not reach `DOMContentLoaded` within 30 seconds after the forged return. The script now waits only for the navigation to start, then for the login form or the review button.
