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
- The Disputes API does not deduplicate on `PayPal-Request-Id`, so the desk stops double sends itself (`dispute_actions`, one row per action and round). Because a retried request can be refused although the first one was filed, an error on sending evidence is followed by a read of the dispute: if a new seller submission with the pack's file names is there, it is recorded as sent ("confirmed by reading the dispute").
- PayPal asked a counter rental for proof of shipment, refund and a delivery signature. The pack is filed as `OTHER` instead of under a type it is not.
- In both runs PayPal held the disputed $20.00 from the shop's balance about three and a half minutes after the case was filed. A decision for the shop released it about a minute after the adjudicate call; a decision for the customer paid it out and charged the shop a $15.00 `DISPUTE_FEE`, the Standard fee the recommendation uses. The panel shows these from `fund_movements`, and the demo stand-in now reports the same movements.
- The sandbox needs minutes between steps. The panel says so and offers "Refresh from PayPal"; in production the webhooks bring the changes.
- `api-m.sandbox.paypal.com` timed out several times during the run. `lib/paypal/rest.ts` now treats a stalled body or a failed token request as a network failure and retries it with the same request id.

PayPal's simulated `CUSTOMER.DISPUTE.UPDATED` and `RESOLVED` payloads (`POST /v1/notifications/simulate-event`) carry the full dispute as `resource`, including `status`, `dispute_outcome` and `links`, but write the links on `api.sandbox.paypal.com` rather than `api-m.sandbox.paypal.com`. The client accepts both names of the same environment's API and always sends the request to the configured base.

An earlier exploratory run the same day, before the panel existed, filed format-test evidence on case `PP-R-CHU-10190215` (capture `8JN17439E0980024P`). PayPal's record of it shows the same sequence: hold placed 3.5 minutes after filing, adjudication `DENY_BUYER` at 08:00:40, hold released at 08:01:34, `RESOLVED_SELLER_FAVOUR`.
