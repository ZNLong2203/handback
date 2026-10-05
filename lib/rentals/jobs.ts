import "server-only";
import { addDaysIso } from "@/lib/dates";
import { getDb } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { depositGateway, PayPalError } from "@/lib/paypal";
import { AUTHORIZATION_VALID_DAYS, HONOR_PERIOD_DAYS, type DepositGateway } from "@/lib/paypal/gateway";
import { appendEvent } from "./audit";
import { updateRental } from "./repo";

const DAY_MS = 86_400_000;
const ACTIVE = ["out", "inspecting", "customer_review", "responded"];

type HoldRow = { id: string; authorization_id: string; authorized_cents: number; authorized_at: Date | string; end_date: Date | string };

/**
 * When to renew a deposit hold. PayPal allows one reauthorization, from 72
 * hours after the hold (measured in the sandbox: refused at 71.9 hours,
 * accepted at 72.3) to day 29, and a renewed hold gets a fresh 3-day honor
 * period but keeps the original expiry. Renewing on day 4 would waste the
 * honor period on a two-week rental, so the renewal waits for the day before
 * the item is due back, and never comes before day 4.
 */
export function renewalDueAt(authorizedAt: Date, endDate: string): Date {
  const earliest = new Date(authorizedAt.getTime() + HONOR_PERIOD_DAYS * DAY_MS);
  const dayBeforeReturn = new Date(`${addDaysIso(endDate, -1)}T00:00:00Z`);
  return dayBeforeReturn > earliest ? dayBeforeReturn : earliest;
}

export type RenewalOutcome = { rentalId: string; outcome: "renewed" | "not-due" | "expired" | "failed"; detail?: string };

/** Renews every active hold that is due. Safe to run as often as you like. */
export async function renewDueHolds(now = new Date(), gateway: DepositGateway = depositGateway()): Promise<RenewalOutcome[]> {
  const db = await getDb();
  const rows = await db.query<HoldRow>(
    `select id, authorization_id, authorized_cents, authorized_at, end_date from rentals
     where status = any($1) and authorization_id is not null and parent_authorization_id is null and authorized_at is not null`,
    [ACTIVE],
  );
  const results: RenewalOutcome[] = [];
  for (const row of rows) {
    const authorizedAt = new Date(row.authorized_at);
    const endDate = row.end_date instanceof Date ? row.end_date.toISOString().slice(0, 10) : String(row.end_date).slice(0, 10);
    if (now.getTime() - authorizedAt.getTime() >= AUTHORIZATION_VALID_DAYS * DAY_MS) {
      results.push({ rentalId: row.id, outcome: "expired" });
      continue;
    }
    if (now < renewalDueAt(authorizedAt, endDate)) {
      results.push({ rentalId: row.id, outcome: "not-due" });
      continue;
    }
    try {
      // One request id per rental per day: retries on the same day are idempotent, and a
      // failure (say, a day too early) does not pin every later attempt to that answer.
      const fresh = await gateway.reauthorize(row.authorization_id, row.authorized_cents, `reauth:${row.id}:${now.toISOString().slice(0, 10)}`);
      await db.tx(async (tx) => {
        await updateRental(tx, row.id, {
          authorization_id: fresh.authorizationId,
          parent_authorization_id: row.authorization_id,
          authorized_at: fresh.createdAt,
          authorization_expires_at: fresh.expiresAt ?? null,
        });
        await appendEvent(tx, row.id, "system", "deposit.reauthorized", {
          from: row.authorization_id,
          authorizationId: fresh.authorizationId,
          amountCents: fresh.amountCents,
          expiresAt: fresh.expiresAt ?? null,
        });
      });
      publish(row.id, "deposit.reauthorized");
      results.push({ rentalId: row.id, outcome: "renewed", detail: fresh.authorizationId });
    } catch (err) {
      const e = PayPalError.is(err) ? err : null;
      await appendEvent(db, row.id, "paypal", "paypal.error", {
        step: "renew the deposit hold",
        status: e?.status ?? 0,
        issue: e?.issue ?? null,
        debugId: e?.debugId ?? null,
      });
      results.push({ rentalId: row.id, outcome: "failed", detail: e?.issue ?? (err instanceof Error ? err.message : String(err)) });
    }
  }
  return results;
}
