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

## 2026-10-02: a renter disputes a settled charge

`scripts/spike-dispute.ts` takes a rental settled on the sandbox (the same browser flow as `scripts/sandbox-walkthrough.ts`), logs in as the sandbox buyer at www.sandbox.paypal.com, files a case in PayPal's Resolution Center on the $35.00 damage capture, and then answers it from the counter's dispute panel in the running app. Every PayPal step below went through the app's own code (`lib/paypal/disputes.ts` via `lib/disputes/service.ts`) unless it says otherwise. Times are UTC.

Rental `R-VRMP3Y`: booking order `0MA82407P1909110K`, fee capture `5AP06223DR0959317` ($87.00), deposit authorization `3TX25764335213158` ($300.00 on the saved wallet), damage capture `4NV53685RT809600J` ($35.00 kept, $265.00 released) at 13:51:00.

| Time | Step | What PayPal returned |
|---|---|---|
| 13:56:35 | Buyer files: "I was billed a different amount" → "I was charged the wrong amount", says $15.00 was right, seller contacted: yes, plus a note | Case `PP-R-HKL-10190228`. The buyer sees the payment as transaction `0M869413G0742232S`, listed as "Preapproved Payment" (the saved wallet), with an "automatic payment" page before the reasons |
| 13:58:03 | `GET /v1/customer/disputes/PP-R-HKL-10190228` | `INCORRECT_AMOUNT`, `dispute_amount` 20.00, stage `CHARGEBACK`, channel `INTERNAL`, status `UNDER_REVIEW`, only a `self` link. `GET /v1/customer/disputes?disputed_transaction_id=4NV53685RT809600J` returned no items yet |
| 14:00:04 | | `fund_movements`: `HOLD_PLACED` 20.00 from the seller (`RECEIVER`, `DEBIT`) |
| 14:00:23 | | `WAITING_FOR_SELLER_RESPONSE`; links `provide_evidence` and `accept_claim`; `allowed_response_options.accept_claim.accept_claim_types` `["REFUND"]`; requested `PROOF_OF_REFUND` and `OTHER`; `seller_response_due_date` 2026-10-13T06:59:59Z. The list by `disputed_transaction_id` now returns it |
| 14:02 | Counter: "Check PayPal for disputes" | Found by the list call, read in full, stored; the rental shows as disputed |
| 14:03:57 | Counter sends the pack (round 1): `evidence_type` `OTHER`, `R-VRMP3Y-evidence.pdf` (SHA-256 `325d470a…`, summary written by `gemini-3.8-flash` and passed the fact check) plus the two original photos, multipart/form-data | 200, debug id `f220242c4dcd9`. Status `UNDER_REVIEW`; only `provide_supporting_info` offered |
| 14:06:41 | | `require_evidence`, `adjudicate` and `accept_claim` links appear, about 2.7 minutes after the evidence |
| 14:06:48 | Counter: sandbox require-evidence `{"action":"SELLER_EVIDENCE"}` | Refused: `MISSING_OR_INVALID_REQUEST_BODY`, debug id `f9903187d5dd5`; the dispute did not change. We did not find the cause: the same body succeeded twice later (next two rows) |
| 14:17:45 | The same require-evidence body sent by hand, without `Prefer` or `PayPal-Request-Id` | 200, debug id `f97130073a62c`. Links drop to `provide_supporting_info` |
| 14:18:13 | | `WAITING_FOR_SELLER_RESPONSE` again; requested `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `PROOF_OF_DELIVERY_SIGNATURE`; new due date 2026-10-06T06:59:59Z |
| 14:54:13 | Counter sends a fresh pack (round 2; SHA-256 `e427ae17…`, the record now includes the dispute), again as `OTHER` because none of the requested types is something an in-store rental has | 200, debug id `f912133b33b30`; a new round, so a new `PayPal-Request-Id` |
| 14:56:23 | | `require_evidence` and `adjudicate` offered again, 2.2 minutes later |
| 14:57:10 | Counter: sandbox require-evidence, same body as at 14:06:48 | 200, debug id `f807543b599d2`; `WAITING_FOR_SELLER_RESPONSE` by 14:57:34 |
| 14:57:59 | Request-id experiment (`spike-dispute.ts replay`): one small PDF sent twice with the same `PayPal-Request-Id` and identical bytes | First: 200, debug id `f20299005f64d`, filed. Second: 422 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`, debug id `f966554107b99`. PayPal did not replay the first answer; it ran the request again against the new state |
| about 15:01 | | `adjudicate` offered, 2 to 4 minutes after that evidence |
| 15:02:26 | Counter: sandbox adjudicate `SELLER_FAVOR` | Accepted, debug id `f198568fe5e99`; status stays `UNDER_REVIEW` for two minutes |
| 15:03:34 | | `fund_movements`: `HOLD_RELEASED` 20.00 back to the seller (`CREDIT`) |
| 15:04:27 | | `RESOLVED`, `dispute_outcome.outcome_code` `RESOLVED_SELLER_FAVOUR`, `outcome_reason` `INELIGIBLE_BUYER_PROTECTION_POLICY`. The rental returns to settled |

A second run, start to finish with `spike-dispute.ts all --customer-wins`, ended the other way. Rental `R-6JWZXR`: booking order `9D2431970P214323G`, fee capture `1H00780667125013X`, authorization `5E408447NM8686102`, damage capture `4BY84394LR2477457`.

| Time | Step | What PayPal returned |
|---|---|---|
| 15:24:05 | Buyer files the same kind of case through the script (buyer transaction `68C156779L057173E`) | Case `PP-R-XKA-10190233`, readable at once with status `OPEN`, then `UNDER_REVIEW` |
| 15:27:34 | | `HOLD_PLACED` 20.00 |
| 15:27:42 | | `WAITING_FOR_SELLER_RESPONSE`, asking for `PROOF_OF_REFUND` and `OTHER`; the list by `disputed_transaction_id` returned it from 15:28:00 |
| 15:29:14 | Counter sends the pack (round 1) | 200, debug id `ca444bdba6a73` |
| 15:31:53 | | `require_evidence`, `adjudicate`, `accept_claim` offered |
| 15:32:13 | Counter: sandbox require-evidence | 200, debug id `f792211799984`, first try |
| 15:33:12 | Counter sends a fresh pack (round 2) | 200, debug id `f903744bcf57c` |
| 15:36:16 | Counter: sandbox adjudicate `BUYER_FAVOR` | Accepted, debug id `f2707289f8529`; adjudication type `RECOVER_FROM_SELLER` |
| 15:37:35 | | `fund_movements`: `DISPUTE_SETTLEMENT` 20.00 debited from the seller, `DISPUTE_FEE` 15.00 debited from the seller, `DISPUTE_SETTLEMENT` 20.00 credited to the buyer; refund transaction `47P84858FY551494G` |
| 15:38:43 | | `RESOLVED`, `RESOLVED_BUYER_FAVOUR`, `outcome_reason` `INELIGIBLE_SELLER_PROTECTION_POLICY`, `amount_refunded` 20.00 |

Design consequences:

- Actions are taken only through the links PayPal returned on a fresh read. The links change with every step, and accepting the claim stayed offered during review.
- A new dispute can be read by id within two minutes, but the list by `disputed_transaction_id` found it only after about four, in both runs. Webhooks (`CUSTOMER.DISPUTE.CREATED`, `UPDATED`, `RESOLVED`) are the main path; the counter's "Check PayPal for disputes" button is the fallback.
- The Disputes API does not deduplicate on `PayPal-Request-Id`, so the desk stops double sends itself (`dispute_actions`, one row per action and round). Because a retried request can be refused although the first one was carried out, an error on any dispute action is followed by a read of the dispute, which looks for the change only that action makes: a new seller submission with the pack's file names (evidence), the accept link gone and the customer refunded (accepting the claim), the offered amount (an offer), new requests to the seller or a new deadline (sandbox require-evidence), a new adjudication or the case resolved (sandbox adjudicate). If it is there, the action is recorded as done ("confirmed by reading the dispute"). The refused retry itself was seen in the sandbox only for evidence. The changes the read looks for were seen there for evidence, require-evidence and adjudicate; accepting a claim and making an offer were not run in the sandbox, so those two checks follow PayPal's schema and are tested only against the stand-in.
- PayPal asked a counter rental for proof of shipment, refund and a delivery signature. The pack is filed as `OTHER` instead of under a type it is not.
- In both runs PayPal held the disputed $20.00 from the shop's balance about three and a half minutes after the case was filed. A decision for the shop released it about a minute after the adjudicate call; a decision for the customer paid it out and charged the shop a $15.00 `DISPUTE_FEE`, the Standard fee the recommendation uses. The panel shows these from `fund_movements`, and the demo stand-in now reports the same movements.
- The sandbox needs minutes between steps. The panel says so and offers "Refresh from PayPal"; in production the webhooks bring the changes.
- `api-m.sandbox.paypal.com` timed out several times during the run. `lib/paypal/rest.ts` now retries a response whose body stalls, and a token request that gets no answer or a 429 or 5xx (also the refresh after a 401), with the same request id.

PayPal's simulated `CUSTOMER.DISPUTE.UPDATED` and `RESOLVED` payloads (`POST /v1/notifications/simulate-event`) carry the full dispute as `resource`, including `status`, `dispute_outcome` and `links`, but write the links on `api.sandbox.paypal.com` rather than `api-m.sandbox.paypal.com`. The client accepts both names of the same environment's API and always sends the request to the configured base.

An earlier exploratory run the same day, before the panel existed, filed format-test evidence on case `PP-R-CHU-10190215` (capture `8JN17439E0980024P`). PayPal's record of it shows the same sequence: hold placed 3.5 minutes after filing, adjudication `DENY_BUYER` at 08:00:40, hold released at 08:01:34, `RESOLVED_SELLER_FAVOUR`.

## 2026-10-03: refunds from the counter

A settled rental from `scripts/sandbox-walkthrough.ts`, run against a dev server in sandbox mode with live Gemini: rental `R-BYNANG`, order `5VT96881B7313973S`, fee capture `5CM53111UC959472K`, deposit authorization `113101924X6498226` ($300.00), two Gemini looks in 5.3 s both reporting the missing lens hood, settlement capture `7H306284X5802020F` ($35.00 kept, $265.00 released). Steps 1 to 4 ran through `scripts/sandbox-refund.ts`, which calls the app's `refundCharge` (`lib/rentals/refunds.ts`) on the app's database; steps 5 and 6 used the refund form on the counter page in a browser.

| # | What we tried | Result |
|---|---|---|
| 1 | Refund $10.00 of the $35.00 capture with a reason, refund number 1 (`PayPal-Request-Id: refund:R-BYNANG:1`, `invoice_id` `R-BYNANG-refund-1`) | Refund `43940452SN0728157`, `COMPLETED`, 10.00. Recorded once, with an audit entry carrying the refund id |
| 2 | The same form again (same number, capture and amount) | Answered from the app's record with the same refund id; PayPal was not called |
| 3 | The same refund request sent to PayPal again with the same `PayPal-Request-Id` | PayPal returned refund `43940452SN0728157` again, `COMPLETED`, 10.00: no second refund |
| 4 | `GET /v2/payments/refunds/43940452SN0728157` and `GET /v2/payments/captures/7H306284X5802020F` | Refund `COMPLETED`, 10.00, `note_to_payer` as sent, `invoice_id` `R-BYNANG-refund-1` (debug_id `ca44b3c842fee`); capture `PARTIALLY_REFUNDED` (debug_id `ca44b3c868996`) |
| 5 | Counter form: refund $30.00 when $25.00 is left | Refused by the app before PayPal: "At most $25.00 is left to refund on the charge from the deposit ($35.00 taken, $10.00 refunded)." |
| 6 | Counter form: refund $5.00, refund number 2 (`refund:R-BYNANG:2`) | Refund `4N364898EK815390T`, `COMPLETED`. The counter lists both refunds; the renter's page shows "The shop refunded $10.00 to you" and "$5.00", and its receipt subtracts $15.00 |

Design consequences:

- PayPal answers a repeated `PayPal-Request-Id` on a refund with the first refund, so a number claimed in the database before the call, and carried by the counter's form, is enough to make a double submit refund once.
- The app checks what is left on the capture itself, so PayPal's `REFUND_AMOUNT_EXCEEDED` is not the first line of defence. We did not send an over-refund to PayPal in this run; the stand-in answers it the way the Payments v2 schema documents.

Not seen in the sandbox: a `PENDING` or `FAILED` refund, a refund refused with `TRANSACTION_DISPUTED` (the app refuses to refund while a dispute is open, before PayPal), and a real `PAYMENT.CAPTURE.REFUNDED` delivery: the dev server had no public URL.

### PayPal's simulated webhook payloads

`POST /v1/notifications/simulate-event` (sent to an example.com URL, so nothing reached the app) returned these sample events, which the webhook handler follows:

- `PAYMENT.CAPTURE.REFUNDED` (debug_id `f6677239e5d50`): `resource_type` `refund`. The resource is the refund, not the capture: `id` is the refund id, with `status`, `amount`, `seller_payable_breakdown` and `links`. The refunded capture appears only as the `up` link, `/v2/payments/captures/{capture id}`. The handler matches the refund id first, then the capture in the `up` link.
- `CHECKOUT.ORDER.APPROVED` (debug_id `f9888362e7320`): `resource_type` `checkout-order`. The resource is the order with `id`, `status` `APPROVED`, `intent`, `purchase_units`, `payer` and `links`. It has no captures and no `payment_source.paypal.attributes.vault`, so it cannot book a rental by itself: the saved-wallet token arrives only with the capture.

Both samples write their links on `api.sandbox.paypal.com`.

### Adding an event type to a registered webhook

`scripts/register-webhook.ts` now adds missing event types to a URL that is already registered, with `PATCH /v1/notifications/webhooks/{id}` (`replace` on `/event_types`, the only operation the endpoint supports). Checked on a throwaway registration for an example.com URL, deleted afterwards: created with two event types (webhook `74W15631HG422952E`, debug_id `ca44b43b39fc3`), the script added the ten missing ones including `CHECKOUT.ORDER.APPROVED`, a GET showed all twelve (debug_id `ca44b43cc2c22`), a second run changed nothing, and the DELETE answered 204.

Capturing a booking from a real `CHECKOUT.ORDER.APPROVED` delivery has not been seen: it needs a deployment with a public URL. The handler is tested against the simulator's payload shape above.
