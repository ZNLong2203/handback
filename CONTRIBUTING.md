# Contributing to Handback

Thanks for taking a look. Bug reports, fixes, tests and docs are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Set up

You need Node.js 22.12 or later (`.nvmrc` pins the major version) and npm.

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
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

To try a whole rental, keep two tabs open:

1. Customer tab: **Rent something**, pick the mirrorless camera kit, enter a name and email, then press **Pay $87.00 (demo PayPal)**. You land on the renter's own page.
2. Counter tab: open http://localhost:3000/shop and pick the rental. Choose the **Pickup photo** sample, then **Hold $300.00 deposit**.
3. Customer tab: press **Yes, this is how I received it**.
4. Counter tab: choose the **Hood removed** return sample, press **Compare the photos**, then **Send 1 item to** the renter.
5. Customer tab: press **That's fair** (or **I question this** with a reason), then **Send my answers**.
6. Counter tab: press **Keep $35.00, release $265.00**. Both pages update without a reload.

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
   | `GEMINI_API_KEY` | Live photo comparison. Without it, only the bundled sample photos can be compared (recorded replies). | `lib/inspection/compare.ts`, `lib/inspection/run.ts` |
   | `AI_MODEL` | Overrides the vision model (default `gemini-3.8-flash`). | `lib/inspection/compare.ts` |
   | `APP_URL` | Public URL, used for PayPal return URLs and the customer's link and QR code. Default `http://localhost:3000`. | `lib/shop.ts` |
   | `DEMO_MODE` | `true` forces the PayPal stand-in and recorded AI replies. | `lib/paypal/config.ts`, `lib/inspection/run.ts` |
   | `DATABASE_URL` | Postgres URL, `memory`, or unset for PGlite in `.data/`. Not in `.env.example`. | `lib/db/client.ts` |
   | `PAYPAL_WEBHOOK_ID` | Id of the registered webhook. Without it the webhook route answers 503. | `lib/paypal/config.ts` |
   | `CRON_SECRET` | Bearer token for `POST /api/jobs/renew-holds`. Without it the route answers 503. | `app/api/jobs/renew-holds/route.ts` |
   | `PAYPAL_SANDBOX_BUYER_EMAIL`, `PAYPAL_SANDBOX_BUYER_PASSWORD` | A sandbox personal account, for the scripted walkthrough only. | `scripts/sandbox-walkthrough.ts` |

   Other entries in `.env.example` (`AI_PROVIDER`, `ANTHROPIC_API_KEY` and the sponsor-tool keys) are placeholders that the code does not read yet.

3. Run `npm run dev`. The strip at the top now says **PayPal: sandbox**. Book as above; the PayPal button opens PayPal's checkout, where you log in with one of the sandbox personal accounts listed in the developer dashboard.

Sandbox buyer passwords often contain `#`. In `.env.local`, wrap such a value in single quotes, or everything after the `#` is dropped as a comment.

### Sandbox scripts

- `npm run smoke:sandbox` runs the real PayPal gateway against the sandbox: it places a hold with a sandbox test card, reads it, settles part of it, repeats the settle with the same `PayPal-Request-Id` to show the retry returns the first capture, refunds part of the capture, voids a second hold, and shows the error for reauthorizing a voided hold.
- `npx tsx --env-file-if-exists=.env.local scripts/sandbox-walkthrough.ts [--headed]` drives the running app (`npm run dev` with sandbox keys, on http://localhost:3000 or `WALKTHROUGH_URL`) in a browser: it clicks the PayPal button, approves as the sandbox buyer in the popup, holds the deposit, compares photos and settles. Set `WALKTHROUGH_SHOTS=<dir>` to save screenshots. The results of one run are in [docs/paypal-sandbox-notes.md](docs/paypal-sandbox-notes.md).
- PayPal only delivers webhooks to public HTTPS URLs on port 443. To receive them, deploy the app, then register its URL with `npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/register-webhook.ts https://<your-host>` and put the printed id in `PAYPAL_WEBHOOK_ID`.

## Tests

```bash
npm run check   # what CI runs first: route types, lint, typecheck, unit tests
npm run e2e     # the browser test, in demo mode
```

- `npm run check` runs `next typegen`, `npm run lint`, `npm run typecheck` and `npm test`. `next typegen` comes first because `tsc` needs the route types Next generates (`PageProps`, `RouteContext`).
- `npm test` runs the vitest suite (`lib/**/*.test.ts`). The rental scenarios run in demo mode against an in-memory database, so they need no keys.
- `npm run e2e` builds the app, starts it in demo mode on port 3200 and drives one rental from booking to settlement with Playwright, with the counter on a desktop and the renter on a phone-sized screen. Run `npx playwright install chromium` once first. `E2E_PORT=3305 npm run e2e` uses another port; `E2E_BASE_URL=http://localhost:3100 npm run e2e` reuses a server that is already running in demo mode; `E2E_SCREENSHOTS=<dir>` saves a screenshot at each step.
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
