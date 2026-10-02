# Security policy

## What this project is

Handback is a hackathon project. It is built and tested against the PayPal sandbox and in demo mode, where a local stand-in replaces PayPal and no money moves. It is not meant to handle real payments: the configuration accepts `PAYPAL_ENVIRONMENT=live`, but the build has the gaps listed under "Known limits" below.

Only the latest commit on the default branch is maintained.

## Reporting a vulnerability

Please do not report a security problem in a public issue.

1. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go to https://github.com/ZNLong2203/handback/security/advisories/new.
2. If private reporting is not available, open an issue that only says you have a security report, with no details, and ask for a private channel.

A useful report says which file, route or page is affected, how to reproduce it in demo mode or against your own sandbox accounts, and what an attacker could do with it.

When you test:

- Use demo mode or your own PayPal sandbox app and sandbox accounts. Never use real card numbers, real PayPal accounts or other people's data.
- Do not put API keys, client secrets, webhook ids or sandbox passwords in a report.

This is a one-person project with no bug bounty and no fixed response time. You will get a reply in the advisory or issue, and credit in the fix if you want it.

## Worth reporting

- A way to move money that skips the review: a capture without the customer's answer, a capture of more than the agreed charges, or a second capture from one settlement.
- A webhook that gets past signature verification (`app/api/paypal/webhooks/route.ts`, `lib/paypal/webhooks.ts`, `lib/paypal/webhook-signature.ts`).
- Calling the hold renewal job (`POST /api/jobs/renew-holds`) without `CRON_SECRET`.
- Reading or answering another customer's rental without their link.
- Secrets that reach the browser, the logs or the repository.

## Known limits of this build

These are known and documented, so they do not need a report:

- The counter pages (`/shop`) have no sign-in. Anyone who can reach a running copy can act as staff.
- A customer's page (`/r/<token>`) is protected only by the random token in its link (18 random bytes).
- The audit log is tamper-evident, not tamper-proof: each entry's hash covers the previous one, but anyone with write access to the database can rewrite the whole chain.
