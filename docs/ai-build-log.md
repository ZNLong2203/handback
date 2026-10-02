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
