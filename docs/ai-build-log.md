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

### 2026-10-02: The dispute desk

Claude Code built the dispute desk (Disputes v1 client, evidence pack, counter panel) and then ran it against a real buyer dispute in the sandbox (`scripts/spike-dispute.ts`, recorded in [paypal-sandbox-notes.md](paypal-sandbox-notes.md)). What the sandbox run corrected:

- The client assumed a reused `PayPal-Request-Id` would make a retried evidence upload safe. The sandbox ran the repeated request again and refused it with a 422 instead of replaying the first answer. The desk now guards double sends itself, and after an error it reads the dispute to see whether PayPal filed the evidence anyway.
- The REST client let a timeout while reading a response body, or a failed token request, escape its retry loop. `api-m.sandbox.paypal.com` stalled several times during the run, which is how this showed up.
- Dispute links were only followed on `api-m.sandbox.paypal.com`. PayPal's own webhook samples write them on `api.sandbox.paypal.com`; both names are now accepted.
- The first spike script hung: outside the Playwright test runner, locator calls wait forever unless a timeout is set.
- One sandbox require-evidence call was refused with `MISSING_OR_INVALID_REQUEST_BODY` and the same body succeeded twice later. The cause was not found; the notes say so rather than guess.
