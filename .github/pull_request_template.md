## What and why

<!-- What this changes and why it is needed. Link the issue, e.g. "Closes #12". -->

## How it was tested

- [ ] `npm run check` (route types, lint, typecheck, unit tests)
- [ ] `npm run e2e`, if a page or the rental flow changed
- [ ] Against my PayPal sandbox, if a PayPal call changed (ids or `debug_id` below)

## Checklist

- [ ] Commit messages follow Conventional Commits (`git config core.hooksPath scripts/hooks` checks them)
- [ ] New PayPal POSTs send a `PayPal-Request-Id` derived from the rental
- [ ] Money stays in integer cents, and amounts are computed on the server
- [ ] Anything a model proposes still goes through the deterministic policy before it can be charged
- [ ] No keys, tokens, sandbox passwords or `.env.local` in the diff
- [ ] README and `docs/` updated if PayPal or AI behaviour changed

## Screenshots

<!-- For UI changes: the counter on a desktop and the customer page on a phone, before and after. -->
