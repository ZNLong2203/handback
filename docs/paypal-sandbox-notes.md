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
