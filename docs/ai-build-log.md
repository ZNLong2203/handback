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
