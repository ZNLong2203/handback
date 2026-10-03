# Contributing to Handback

Thanks for taking a look. Bug reports, fixes, tests and docs are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Set up

You need Node.js 22.12 or later (`.nvmrc` pins the major version) and npm.

```bash
git clone https://github.com/ZNLong2203/handback.git
cd handback
nvm use        # optional: picks Node 22 from .nvmrc
npm ci
git config core.hooksPath scripts/hooks
```

The last line turns on this repository's git hooks (see [Commits](#commits)).

You can also open the repository in GitHub Codespaces or any dev container. `.devcontainer/devcontainer.json` installs dependencies, sets `DEMO_MODE=true` and `DATABASE_URL=memory`, and starts the dev server on port 3000.

## Run it in demo mode

Demo mode needs no accounts and no keys:

```bash
npm run dev
```

Open http://localhost:3000. With no PayPal credentials the app uses a local stand-in for PayPal (`lib/paypal/demo-gateway.ts`) that enforces the rules we measured in the sandbox, and with no Gemini key the photo comparison replays recorded Gemini replies for the bundled sample photos. `DEMO_MODE=true` forces both, even when keys are set. The strip at the top of every page says which parts are real.

Data goes to an in-process Postgres (PGlite) in `.data/pglite`, so it survives restarts. Delete `.data/` to start over, or set `DATABASE_URL=memory` for a database that disappears when the server stops. With any other `DATABASE_URL` the app connects to that Postgres. In every case the idempotent schema in `lib/db/schema.sql` is applied when the app first connects.

To try a whole rental, follow the six steps under [Run it in two minutes](README.md#run-it-in-two-minutes) in the README, with one tab as the renter and one as the counter.

## Run it against the PayPal sandbox

1. In the [PayPal developer dashboard](https://developer.paypal.com/dashboard/), open **Apps & Credentials**, switch to **Sandbox** and create a REST app bound to a US sandbox business account. In the app's features under accepting payments, make sure **Vault** is enabled: the booking saves the renter's PayPal for the deposit hold.
2. Copy the template and fill in the keys:

   ```bash
   cp .env.example .env.local
   ```

   | Variable | What it does | Read in |
   |---|---|---|
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials. Without them the app runs in demo mode. | `lib/paypal/config.ts` |
   | `PAYPAL_ENVIRONMENT` | `sandbox` (default) or `live`. | `lib/paypal/config.ts` |
   | `GEMINI_API_KEY` | Live Gemini: the photo comparison, the dispute summary, the schedule's messages and typed commands. Without it, only the bundled sample photos can be compared (recorded replies), and the others use templates or a simple parser. | `lib/inspection/compare.ts`, `lib/inspection/run.ts`, `lib/disputes/narrative.ts`, `lib/schedule/gemini.ts`, and the eval and demo scripts |
   | `AI_MODEL` | Overrides the Gemini model (default `gemini-3.8-flash`). | `lib/inspection/compare.ts`, `lib/disputes/narrative.ts`, `lib/schedule/gemini.ts`, `lib/health.ts` |
   | `APP_URL` | Public URL, used for PayPal return and cancel URLs and the customer's link and QR code. Default `RENDER_EXTERNAL_URL`, then `http://localhost:3000`. | `lib/shop.ts` |
   | `DEMO_MODE` | `true` forces the PayPal stand-in, recorded AI replies and template texts. | `lib/paypal/config.ts`, `lib/inspection/run.ts`, `lib/disputes/narrative.ts` |
   | `DATABASE_URL` | Postgres URL, `memory`, or unset for PGlite in `.data/`. Not in `.env.example`. | `lib/db/client.ts`, `lib/health.ts` |
   | `PAYPAL_WEBHOOK_ID` | Id of the registered webhook. Without it the webhook route answers 503. | `lib/paypal/config.ts` |
   | `CRON_SECRET` | Bearer token for `POST /api/jobs/renew-holds`. Without it the route answers 503. | `app/api/jobs/renew-holds/route.ts`, `scripts/cron/renew-holds.mjs` |
   | `SHOP_ACCESS_CODE` | The counter's shared access code, at least 12 characters. Set: every `/shop` page, every counter, dispute-desk and schedule server action, `/api/live/shop` and `/api/evidence/*` need the staff cookie that `/shop/sign-in` issues for this code; changing it signs everyone out. Unset or empty (local, demo clones, CI, tests): the counter is open, as before. Set but shorter, or only spaces: the counter is closed to everyone. | `lib/staff-access.ts` |
   | `STAFF_COOKIE_SECRET` | Optional server secret mixed into the staff cookie's key, so a leaked cookie cannot be tested against guessed codes offline. `render.yaml` generates one. Changing it signs everyone out. | `lib/staff-access.ts` |
   | `TRUSTED_PROXY_HOPS` | How many `X-Forwarded-For` entries at the end were added by proxies after the one that saw the client (default 0: the last entry). Wrong codes are counted against that address; `/api/health` shows it as `staffAccess.countedAs`. | `lib/staff-access.ts` |
   | `PUBLIC_DEMO` | `true` on a copy shared with hackathon judges: the sign-in page then says the code is in the Devpost testing instructions. Otherwise it gives a neutral hint. | `lib/staff-access.ts` |
   | `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` | With both, photo comparisons and hold renewals run as Render Workflows tasks; otherwise in the web process. `render.yaml` sets the slug. | `lib/workflows/config.ts` |
   | `RENDER_WORKFLOWS` | `off` keeps jobs in the web process even when Render Workflows is set up. Not in `.env.example`. | `lib/workflows/config.ts` |
   | `RENDER_USE_LOCAL_DEV`, `RENDER_LOCAL_DEV_URL` | Send task runs to `render workflows dev` (the Render SDK's default is `http://localhost:8120`). | `lib/workflows/config.ts` |
   | `HANDBACK_URL`, `HANDBACK_HOSTPORT` | Where the cron job finds the web service. `render.yaml` sets `HANDBACK_HOSTPORT`. Not in `.env.example`. | `scripts/cron/renew-holds.mjs` |
   | `SEED_VAULT_ID` | A saved sandbox wallet, or `latest`, for `npm run seed:demo` in sandbox mode. | `scripts/seed-demo.ts` |
   | `ANTHROPIC_API_KEY` | The MCP demo client uses Claude when this is set, Gemini otherwise. | `scripts/agent-books.ts` |
   | `AGENT_MODEL` | Model for the MCP demo client (default `claude-opus-5-5` with Claude, `gemini-3.8-flash` with Gemini). | `scripts/agent-books.ts` |
   | `MCP_URL` | Endpoint for the MCP demo client. Default `$APP_URL/api/mcp`. | `scripts/agent-books.ts` |
   | `PAYPAL_SANDBOX_BUYER_EMAIL`, `PAYPAL_SANDBOX_BUYER_PASSWORD` | A sandbox personal account, for the scripts that approve in PayPal's checkout. | `scripts/lib/sandbox-browser.ts`, `scripts/sandbox-agent-booking.ts`, `scripts/spike-vault.ts` |

   Read only by scripts and tests, and not in `.env.example`:

   | Variable | What it does | Read in |
   |---|---|---|
   | `WALKTHROUGH_URL`, `WALKTHROUGH_SHOTS` | The app the walkthrough drives (default `http://localhost:3000`), and a folder for its screenshots. | `scripts/sandbox-walkthrough.ts`, `scripts/sandbox-agent-booking.ts` (screenshots only) |
   | `SPIKE_URL`, `SPIKE_SHOTS` | The app the dispute spike drives (default `http://localhost:3000`), and a folder for screenshots. | `scripts/spike-dispute.ts`, `scripts/spike-vault.ts` (screenshots only) |
   | `HEADED` | `1` shows the browser in the vault spike. | `scripts/spike-vault.ts` |
   | `GEMINI_IMAGE_MODEL` | Image model that edits the eval photos (default `gemini-3-pro-image`). | `scripts/eval/make-pairs.ts` |
   | `TEST_DATABASE_URL` | A Postgres to round-trip JSON through in the database client test; skipped when unset. | `lib/db/client.test.ts` |
   | `EVIDENCE_PDF_OUT` | Path where the evidence test writes a sample PDF to look at. | `lib/disputes/evidence.test.ts` |
   | `E2E_PORT`, `E2E_BASE_URL`, `E2E_SCREENSHOTS` | Playwright options; see [Tests](#tests). | `playwright.config.ts`, `e2e/*.spec.ts` |

   Set by the platform, never by hand: `RENDER_EXTERNAL_URL` (the fallback for `APP_URL`), `RENDER_GIT_COMMIT` and `RENDER_GIT_BRANCH` (shown by `/api/health`), `RENDER_SDK_SOCKET_PATH` (present in a Render Workflows task run; `workflows/main.ts` stops without it) and `CI` (GitHub Actions).

3. Run `npm run dev`. The strip at the top now says **PayPal: sandbox**. Book as above; the PayPal button opens PayPal's checkout, where you log in with one of the sandbox personal accounts listed in the developer dashboard.

Sandbox buyer passwords often contain `#`. In `.env.local`, wrap such a value in single quotes, or everything after the `#` is dropped as a comment.

### Sandbox scripts

- `npm run smoke:sandbox` runs the real PayPal gateway against the sandbox: it places a hold with a sandbox test card, reads it, settles part of it, repeats the settle with the same `PayPal-Request-Id` to show the retry returns the first capture, refunds part of the capture, voids a second hold, and shows the error for reauthorizing a voided hold.
- `npx tsx --env-file-if-exists=.env.local scripts/sandbox-walkthrough.ts [--headed]` drives the running app (`npm run dev` with sandbox keys, on http://localhost:3000 or `WALKTHROUGH_URL`) in a browser: it clicks the PayPal button, approves as the sandbox buyer in the popup, holds the deposit, compares photos and settles. Set `WALKTHROUGH_SHOTS=<dir>` to save screenshots. The results of one run are in [docs/paypal-sandbox-notes.md](docs/paypal-sandbox-notes.md).
- `npx tsx --env-file-if-exists=.env.local scripts/sandbox-agent-booking.ts [--early-return] [--cancel-first] [--settle]` books over MCP against the running app in sandbox mode (with `APP_URL` set to its address) and approves PayPal's link as the sandbox buyer; `--settle` then runs the rental to a final capture at the counter. See [docs/agents.md](docs/agents.md).
- `npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/sandbox-refund.ts <rental id> <amount> "<reason>"` refunds part of a settled sandbox rental through the app's own `refundCharge`, sends the same refund to PayPal again with the same `PayPal-Request-Id` to show it is not refunded twice, and reads the refund and the capture back. It opens the app's database, so with PGlite stop the dev server first.
- `npm run agent:book -- "rent a drone this weekend for Sam, sam@example.com"` gives the request to Gemini, or to Claude when `ANTHROPIC_API_KEY` is set, with the MCP tools, and prints PayPal's approval link.
- `npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/spike-dispute.ts all [--customer-wins]` settles a rental in the running app, files a buyer dispute in the sandbox Resolution Center, and answers it from the counter. It keeps its state in `private/`, which git ignores.
- `npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/schedule-ai-smoke.ts` sends the schedule's prompts to the real Gemini API once.
- `npm run seed:demo` walks six rentals to six different steps of the counter. In sandbox mode it needs `SEED_VAULT_ID`; see [docs/deploy.md](docs/deploy.md).
- PayPal only delivers webhooks to public HTTPS URLs on port 443. To receive them, deploy the app, then register its URL with `npm run paypal:webhook -- https://<your-host>` and put the printed id in `PAYPAL_WEBHOOK_ID`. Run it again after this list of events grows (it now includes `CHECKOUT.ORDER.APPROVED`): for a URL already registered it adds the missing event types.
- The scripts that drive the counter in a browser (`sandbox-walkthrough.ts`, `sandbox-agent-booking.ts --settle`, `spike-dispute.ts`) expect a server without `SHOP_ACCESS_CODE`.

## Tests

```bash
npm run check   # what CI runs first: route types, lint, typecheck, unit tests
npm run e2e     # the browser tests, in demo mode
```

- `npm run check` runs `next typegen`, `npm run lint`, `npm run typecheck` and `npm test`. `next typegen` comes first because `tsc` needs the route types Next generates (`PageProps`, `RouteContext`).
- `npm test` runs the vitest suite (every `*.test.ts` outside `node_modules`, `.next` and `.claude`). The rental, dispute, MCP and schedule scenarios run in demo mode against an in-memory database, so they need no keys.
- `npm run e2e` builds the app, starts three demo-mode servers on ports 3200, 3201 and 3202 (the schedule spec gets its own, because the other specs' bookings would change the demo schedule it checks, and the staff-access spec gets the only one with `SHOP_ACCESS_CODE` set) and runs the six Playwright specs in `e2e/` (a rental from booking to settlement and a refund, a city bike with one charge accepted and one waived, the dispute desk, an assistant's booking over MCP, the schedule, and the counter's access code), with the counter on a desktop and the renter on a phone-sized screen. Run `npx playwright install chromium` once first. `E2E_PORT=3305 npm run e2e` uses ports 3305 to 3307; `E2E_BASE_URL=http://localhost:3100 npm run e2e` reuses a server that is already running in demo mode for every spec except the staff-access one, which is skipped; `E2E_SCREENSHOTS=<dir>` saves a screenshot at each step.
- `npm run eval` scores the photo comparison on the labeled pairs in `eval/`. It calls Gemini for every pair, so it needs `GEMINI_API_KEY` and uses API quota. See [eval/README.md](eval/README.md).

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same steps as `npm run check`, and `npm run e2e` in a second job, on every push and pull request. Neither needs secrets.

## How the code is written

- Read [AGENTS.md](AGENTS.md) first. This is Next.js 16: `params` are async, route types come from `next typegen`, and the bundled docs in `node_modules/next/dist/docs/` are the reference.
- Money is integer cents everywhere (`lib/money.ts`) and becomes a PayPal decimal string only at the API boundary. Amounts are computed on the server, never taken from the browser.
- Every PayPal POST sends a `PayPal-Request-Id`. In the rental flow it is derived from the rental (`settle:<rental id>`), so a double tap or a retry cannot move money twice.
- Anything a model proposes passes deterministic code before it can become a charge (`lib/inspection/policy.ts`, `lib/inspection/consensus.ts`).
- Server modules import `server-only`. Errors meant for people are `UserError`s with a message that says what to do next; PayPal failures keep PayPal's `issue` and `debug_id`.
- Prefer small pure functions with a test next to them (`*.test.ts`).
- UI copy and docs are plain and specific. Do not describe something the code does not do.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- The scope is optional and lowercase, for example `paypal`, `inspection`, `rentals`, `ui`, `e2e`, `repo`.
- The subject is at most 72 characters. The body explains why the change is needed.

With `git config core.hooksPath scripts/hooks`, two hooks run on every commit:

- `scripts/hooks/commit-msg` rejects a subject that does not follow the format above.
- `scripts/hooks/pre-commit` blocks `private/`, `.env` and `.env.local` files, credential-shaped strings (Google, Anthropic, OpenAI and GitHub keys, PayPal access tokens and client secrets), and non-empty secret values in `.env.example`.

## Pull requests

- Keep one topic per pull request and fill in the template.
- Run `npm run check`, and `npm run e2e` when a page or the rental flow changes.
- If you change a PayPal call, run it against your sandbox and include the ids or the `debug_id` you got.
- Update the README tables and `docs/paypal-sandbox-notes.md` when PayPal or AI behaviour changes.
