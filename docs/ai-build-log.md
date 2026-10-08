# AI build log

A running record of how AI coding tools were used to build this project: the tool, what it was asked to do, what it produced, and what had to be corrected. Newest entries go at the bottom.

## Tools

- **Claude Code** (Claude Opus 5.5): research, scaffolding, implementation, and review.

## Log

### 2026-10-02: Checking the PayPal packages before writing code

Checked the current releases on npm instead of relying on model memory:

| Package | Version |
|---|---|
| `@paypal/paypal-server-sdk` | 2.5.0 |
| `@paypal/agent-toolkit` | 1.11.0 |
| `@paypal/mcp` | 1.8.1 |
| `@paypal/react-paypal-js` | 10.5.2 |
| `ai` (Vercel AI SDK) | 7.0.126 |

Findings that shape the design:

- The Server SDK covers Orders, Payments, Vault, Transaction Search and Subscriptions. Payouts, Invoicing and Disputes need direct REST calls.
- `@paypal/agent-toolkit` exposes 47 tools. Its `ai-sdk` entry point depends on `ai@^4` and emits v4-shaped tool definitions, which AI SDK 7 does not accept. Its `openai` entry point returns plain JSON-schema function definitions plus `handleToolCall()`, so it can sit behind a small provider-neutral adapter.
- The toolkit's `getHeaders()` fetches one OAuth token and reuses it for the life of the process (`this._accessToken = this._accessToken || await this.getAccessToken()`), ignoring `expires_in`. A long-running server would start getting 401s once that token expires, so tokens should be minted and refreshed by our own server code.

### 2026-10-02: Writing the deposit gateway against the Server SDK

The PayPal Server SDK Context Plugin (`paypaldev/server-sdk-context-plugin-preview`, TypeScript skills) was used as the grounding source for `lib/paypal/`. What it changed:

- `typescript-configuration-resilience` says to read `DEFAULT_RETRY_CONFIG` instead of assuming retries exist. In 2.5.0 it is `maxNumberOfRetries: 0` with `httpMethodsToRetry: ['GET', 'PUT']`, so a 429 or 503 on capture would have failed outright. `lib/paypal/sdk.ts` now retries GET, POST and PATCH. POST retries are safe only because every POST sends a `PayPal-Request-Id`, and `npm run smoke:sandbox` confirmed that a retried capture with the same id returns the original capture.
- `typescript-calling-endpoints` flagged that operations take one options object (`captureAuthorizedPayment({ authorizationId, paypalRequestId, prefer, body })`) and that controllers are constructed, not read off the client. Signatures were then confirmed in `node_modules/@paypal/paypal-server-sdk/src/controllers/`.
- `typescript-error-handling` notes that `result` can be undefined on a bare `ApiError`. `lib/paypal/errors.ts` falls back to parsing `body` and the `paypal-debug-id` header, so every failure keeps PayPal's `issue` and `debug_id`.
- `typescript-getting-started` notes that the root barrel mixes value and type exports; enums are imported as values and models with `import type`.
- The SDK's `ClientCredentialsAuthManager` refreshes expired tokens itself, unlike the Agent Toolkit client noted above, so the gateway uses one long-lived SDK client.

### 2026-10-02: A second eval set on real photographs

Claude Code built `eval/real/`: 55 labeled pairs on 11 Wikimedia Commons photographs, with the same scoring as the synthetic set. What it did and what had to be corrected:

- **Licenses.** Every photo's author, license and file version (sha1) was checked against its Commons page through the Commons API, and the three Flickr imports have a passed license review. The builder refuses to download a photo whose file or license has changed since. `eval/real/CREDITS.md` lists each source and keeps adaptations under the photo's own license.
- **The image model redraws the whole photo.** Pasting only a box of its edit back onto the original keeps the rest real, but on review the edits were often shifted or zoomed by a few percent (up to 7% on the telephoto shots), which left doubled edges at the box's border. `scripts/eval/composite.ts` now lines the edit up with the original before pasting.
- **A code bug found by looking.** The "warmer light" shift used `sharp.tint()`, which replaces every colour: invisible on the grey synthetic scenes, but it turned the real photos sepia. Real photos now get a white-balance shift.
- **Edits that did not happen.** Of 22 edits, five came back without the requested change or with an artefact (a hood left on, a handle not cracked, a crack too faint to see, a smudge where a strap was removed, a tripod foot only chipped). Their prompts were rewritten and run again; where a second try still differed from the request, the label was changed to what the photo shows.
- **Network errors scored as misses.** The first run lost two requests to "fetch failed", and the scoring counted one as a missed scratch. The eval runner now resends requests that fail on the network or get a 429/5xx and records how many it resent; that run was repeated.
- **Model mistakes the real photos exposed.** Nothing unchanged was charged in any run, but the model kept reporting text as "upside down" after a 3° turn and glare as worn rubber or scuffed paint. Naming both cases in the prompt (v2) removed the first and not the second. On the e-bike it made glare worse: the seat-tube finding went from 1 of 3 runs to 3 of 3, and in 2 of them both looks agreed on it at high confidence, so only the missing frame entry in the price list kept it off the bill. The number of unchanged pairs with a finding did not change. The proposed fix for glare is a check on the photo in code. Details and before/after numbers are in `eval/README.md`, which `npm run eval:summary` now computes from the saved runs (a test fails when it is out of date).
- **Pasted boxes can show.** The pasted box's colour is matched to the original with one average shift per channel, which leaves a faint step at the box edge where the image model redrew a plain background in a different tone, and some boxes cover up to 43% of the frame. `eval/README.md` says where; the photos were not re-pasted because that would void every saved run.

### 2026-10-02: Assistant bookings over MCP

- Checked npm first. `@modelcontextprotocol/sdk` 1.31.0 is current; the split v2 packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, 2.2.0) also exist. The server uses 1.31.0's `WebStandardStreamableHTTPServerTransport`, which takes a Web `Request` and returns a `Response`, so a Next.js route handler needs no Express shim. Reading the transport's source showed that in JSON response mode the `Response` body is a finished string, so the per-request server can be closed as soon as `handleRequest` returns.
- `McpServer` sends a thrown error's message straight back to the client. Tool handlers now return a `UserError`'s message and replace anything else with a generic one, so database or SDK internals do not reach an assistant.
- In stateless mode every request gets a fresh server, so the request that books never sees the client's `initialize` and its name. The mandate records the name the assistant gives itself and says it is self-reported.
- In the demo client, Gemini copied the "e.g. Claude" example from a tool parameter's description and named itself Claude. The example is gone, and the script tells the model which assistant it is.
- Unit tests passed while the real thing failed: in the sandbox, a rental page that should have shown PayPal's `ORDER_NOT_APPROVED` refusal answered 500. Next.js gives route handlers and pages separate copies of a module, and the PayPal gateway created by the MCP route is shared through `globalThis`, so `instanceof PayPalError` failed in the page. Errors now carry a `Symbol.for` brand (`PayPalError.is`), and a test builds the error from a second copy of the module.
- The booking form's consent line said the shop charges only damage the renter "has not questioned", but the code lets a person at the shop keep a questioned charge. The mandate states what the code does, and the consent line now matches it.
- A review of the branch found four places where the code did less than the docs said, none caught by the tests at the time. `create_booking` returned the renter's page link, which can answer charges, while the docs said only the renter could; the assistant now gets a read-only status token, and PayPal's cancel link no longer leads to the renter's page. The mandate check trusted the hash in one audit entry without checking the chain. Return inspections priced findings from the live catalog rather than the mandate. A `PENDING` booking capture was shown to the renter as a failure, with a button to pay again. Each fix came with a test that fails without it.

### 2026-10-02: The dispute desk

Claude Code built the dispute desk (Disputes v1 client, evidence pack, counter panel) and then ran it against a real buyer dispute in the sandbox (`scripts/spike-dispute.ts`, recorded in [paypal-sandbox-notes.md](paypal-sandbox-notes.md)). What the sandbox run corrected:

- The client assumed a reused `PayPal-Request-Id` would make a retried evidence upload safe. The sandbox ran the repeated request again and refused it with a 422 instead of replaying the first answer. The desk now guards double sends itself, and after an error it reads the dispute to see whether PayPal filed the evidence anyway.
- The REST client let a timeout while reading a response body, or a failed token request, escape its retry loop. `api-m.sandbox.paypal.com` stalled several times during the run, which is how this showed up.
- Dispute links were only followed on `api-m.sandbox.paypal.com`. PayPal's own webhook samples write them on `api.sandbox.paypal.com`; both names are now accepted.
- The first spike script hung: outside the Playwright test runner, locator calls wait forever unless a timeout is set.
- One sandbox require-evidence call was refused with `MISSING_OR_INVALID_REQUEST_BODY` and the same body succeeded twice later. The cause was not found; the notes say so rather than guess.

### 2026-10-08: The stored photo hid the bike's rear light

With Gemini live, the demo video's story (a city bike back without its phone holder and its small red rear light) proposed only the phone holder, in 4 of 4 tries in the app. The eval had never seen the bytes the app sends: it reads the photo files as they are, while the app compares the photo it stored, which `storePhoto` re-encoded as JPEG quality 85 (mozjpeg) with colour at half resolution (4:2:0). Claude Code measured single looks (gemini-3.8-flash, thinking low, prompt v2) at each encoding, mostly sending the encodings of a pair in turn so that changes in the service over time hit them alike (the q92 looks and the other pairs' q95 looks came in later batches):

| Pair, change | Files as they are | q85 4:2:0 (old) | q85 4:4:4 | q90 4:2:0 | q90 4:4:4 | q92 4:4:4 | q95 4:4:4 (new) |
|---|---|---|---|---|---|---|---|
| `city-bike__missing-holder-rear-light`, rear light | 12/12 | 0/6 | 0/6 | 2/6 | 7/12 | 6/6 | 12/12 |
| the same pair, phone holder | 12/12 | 6/6 | 6/6 | 6/6 | 12/12 | 6/6 | 12/12 |
| `bike-rack__broken-reflector` (real set) | 6/6 | 6/6 | | | 6/6 | | 6/6 |
| `dji-mini4__broken-propeller` (real set) | 6/6 | 6/6 | | | 6/6 | | 6/6 |
| `projector__cracked-lens` (synthetic set) | 6/6 | 6/6 | | | 6/6 | | 6/6 |
| `sigma-150-600__missing-hood` (real set) | 0/12 | 0/12 | | | 0/6 | | 7/12 |
| Size of the bike's return photo | 147 KB | 118 KB | 128 KB | 143 KB | 159 KB | 168 KB | 198 KB |

Each cell is the looks that proposed the change as a charge. No look proposed a charge for anything that had not changed.

- **Quality, more than colour resolution.** The guess was that halving colour resolution smeared the small red light. At quality 85 the light was gone with full colour resolution too; at 90 full colour resolution helped a little (2 of 6 to 7 of 12), and from 92 up the model saw it every time. The sample photos are JPEGs already (quality 86, colour at half resolution), as every upload is (the counter's camera button shrinks a photo in the browser and sends a JPEG at quality 0.88), so the app was compressing them a second time, and at 85 mozjpeg's tables leave files 20% smaller than the originals.
- **The fix.** `lib/photo-encoding.ts` holds the encoding, and `storePhoto` and the eval runner both call it: EXIF orientation, metadata dropped, at most 1600 px, as before, then JPEG quality 95 with full colour resolution. Quality 95 rather than 92 leaves room above where the light disappeared. Over the 116 bundled photos the mean stored size goes from 133 KB to 213 KB (the files themselves average 164 KB), and a detailed photo at 1600 px comes to about 0.9 MB (2.3 MB for fine-grained noise at 1600 × 1200), far below the 8 MB upload limit and PayPal's 10 MB per evidence file. The photo checks' thresholds did not change; a new test runs every sample photo the demo offers through the encoding and the checks, and checks that a blurred photo is still turned away.
- **Something not explained.** At quality 95 the Sigma lens's removed hood was seen in 7 of 12 looks against 0 of 12 on the files and at the old encoding. One pair cannot say why, and it is not why 95 was chosen.
- **Considered and not done.** Passing a JPEG that needs no turning or resizing straight through would send the eval's exact bytes, but it would keep any metadata unless the file were rewritten by hand, and it adds a second path; quality 95 did as well as the files on every pair measured.
- **What it changes elsewhere.** The same photo now gets a different SHA-256 than before. Nothing depends on the old ones: demo mode finds its recorded replies by sample name, not hash; photos already stored keep their bytes and hash; no test pins a photo hash; the README screenshots show hash prefixes from an older run, which nothing checks.
- **Checked in the app.** On a local server with Gemini live (PayPal on the stand-in), the bike story proposed both the phone holder and the rear light in 5 of 5 runs. Through the eval with the new `--app-encoding` option (two looks, prompt v2, two runs of each set) the real-photo set had 43 of 44 changes charged, against 63 of 66 in the three published runs on the files, and the synthetic set 28 of 28, against 41 of 42; no unchanged pair was charged, and every charge had the right price-list entry. These runs were about twice as slow as the published ones, and so was a run on the files the same day, so the service was slow, not the photos. `eval/README.md` shows them next to the published runs, which stay as they were.
