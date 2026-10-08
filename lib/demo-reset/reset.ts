import "server-only";
import { getDb } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { depositGateway, dropDemoStandIns, PayPalError, type DepositGateway } from "@/lib/paypal";
import type { PayPalMode } from "@/lib/paypal/config";
import { seedInsightsHistory } from "@/lib/insights/seed";
import { seedDemoSchedule, seedSandboxSchedule } from "@/lib/schedule/seed";
import { seedCounter } from "@/lib/seed/run";
import { demoResetConfig, liveRefusal, resetDayOf, resetSeedWallet, type Env } from "./config";

// The nightly reset of the public demo. Judges try the same copy for weeks,
// as renter and as staff; without a reset, every earlier visitor's
// half-finished rental stays on the counter. Off unless DEMO_RESET=true, and
// refused outright with live PayPal.

/**
 * Every table that holds rentals or anything that happened to them, emptied
 * in one transaction. The test checks that every table in the schema is
 * either here or in KEPT_TABLES, so a new table has to be placed in one.
 */
export const WIPED_TABLES = [
  "rentals",
  "events",
  "photos",
  "inspections",
  "assessments",
  "refunds",
  "disputes",
  "dispute_actions",
  "evidence_packs",
  "blocks",
  "schedule_proposals",
  "webhook_events",
  "demo_paypal",
  "demo_seeds",
] as const;

/** Reference data, and the reset's own record of the days it ran. */
export const KEPT_TABLES = ["units", "demo_resets"] as const;

/** Where a deposit is held on PayPal: the statuses renewDueHolds treats as active (lib/rentals/jobs.ts). */
const HOLDING = ["out", "inspecting", "customer_review", "responded"];

/** A rerun may take over a day whose run has said nothing for this long; it most likely died with its process. */
const STALE_RUN = "30 minutes";

export type HoldRelease = {
  rentalId: string;
  authorizationId: string;
  requestId: string;
  outcome: "voided" | "failed";
  detail?: string;
};

export type ResetSummary = {
  mode: PayPalMode;
  deletedRentals: number;
  /** Sandbox only: the open deposit holds voided (or not) before the wipe. */
  released: HoldRelease[];
  /**
   * Rentals booked again by the counter seed, the schedule seed (the demo
   * fortnight, or in the sandbox its version from today on) and the owner's
   * dashboard's sample history (demo mode only), in that order.
   */
  seeded: { counter: number; schedule: number; insights: number; note?: string };
};

export type ResetResult =
  | { status: "off"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "already-done"; day: string; state: "done" | "running"; startedAt: string }
  | ({ status: "reset"; day: string } & ResetSummary);

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Deletes every rental and everything recorded about it, then seeds the
 * counter the way a fresh deployment is seeded: `npm run seed:demo`'s
 * scenarios for the current PayPal mode and, in demo mode, the two-week
 * demo schedule and then the owner's dashboard's sample history, in that
 * order. In the sandbox it first voids the deposit holds that are still
 * open, so visitors' sandbox money is not left on hold; it never captures or
 * refunds a visitor's payment. (With SEED_VAULT_ID set, the sandbox seeds
 * afterwards make new sandbox payments with that wallet for the counter's
 * sample rentals and the schedule's fortnight, as `npm run seed:demo` does.
 * The dashboard's history is not seeded there: it needs holds and
 * settlements moved back in time, which only the stand-in can do.) At most
 * once per reset day (see resetDayOf); a second call that day returns
 * "already-done".
 */
export async function resetDemo(opts: { now?: Date; env?: Env } = {}): Promise<ResetResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const config = demoResetConfig(env);
  if (!config.enabled) return { status: "off", reason: "DEMO_RESET is not true on this service, so nothing was reset." };
  const gateway = depositGateway();
  const refusal = config.refusal ?? liveRefusal(gateway.mode);
  if (refusal) return { status: "refused", reason: refusal };

  const db = await getDb();
  const day = resetDayOf(now, config.hourUtc);
  const claimed = await db.query(
    `insert into demo_resets (day, status) values ($1, 'running')
     on conflict (day) do update set status = 'running', started_at = now(), finished_at = null, summary = null, error = null
     where demo_resets.status = 'failed' or (demo_resets.status = 'running' and demo_resets.started_at < now() - interval '${STALE_RUN}')
     returning day`,
    [day],
  );
  if (claimed.length === 0) {
    const [row] = await db.query<{ status: "done" | "running"; started_at: unknown }>("select status, started_at from demo_resets where day = $1", [day]);
    console.log(`Demo reset: ${day} is already ${row.status === "done" ? "done" : "running"}; nothing to do.`);
    return { status: "already-done", day, state: row.status, startedAt: iso(row.started_at) };
  }

  try {
    const summary = await wipeAndSeed(gateway, now, env);
    await db.query("update demo_resets set status = 'done', finished_at = now(), summary = $2::jsonb where day = $1", [day, JSON.stringify(summary)]);
    console.log(
      `Demo reset ${day}: deleted ${summary.deletedRentals} rentals, voided ${summary.released.filter((r) => r.outcome === "voided").length} of ${summary.released.length} open holds, seeded ${summary.seeded.counter} counter, ${summary.seeded.schedule} schedule and ${summary.seeded.insights} dashboard rentals.`,
    );
    return { status: "reset", day, ...summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query("update demo_resets set status = 'failed', finished_at = now(), error = $2 where day = $1", [day, message.slice(0, 500)]).catch(() => {});
    throw err;
  }
}

async function wipeAndSeed(gateway: DepositGateway, now: Date, env: Env): Promise<ResetSummary> {
  const mode = gateway.mode;
  // The demo stand-in's state is wiped with everything else; only real sandbox holds need voiding.
  const released = mode === "sandbox" ? await releaseOpenHolds(gateway) : [];

  const db = await getDb();
  const deletedRentals = await db.tx(async (tx) => {
    const [{ n }] = await tx.query<{ n: number }>("select count(*)::int as n from rentals");
    // No CASCADE: a table that references these and is not listed makes the
    // truncate fail, rather than being emptied without anyone deciding to.
    await tx.query(`truncate table ${WIPED_TABLES.join(", ")} restart identity`);
    return n;
  });
  if (mode === "demo") dropDemoStandIns();

  const vaultId = resetSeedWallet(mode, env);
  if (mode === "sandbox" && env.SEED_VAULT_ID?.trim() === "latest") {
    console.log("Demo reset: SEED_VAULT_ID=latest is not used by the reset, because the newest saved wallet may be a visitor's. Set it to your own sandbox buyer's vault id.");
  }
  const counter = await seedCounter({ vaultId });
  for (const line of counter.lines.filter((l) => l.stopped)) console.error(`Demo reset: the seed stopped ${line.scenario.name}: ${line.stopped}`);
  let schedule = 0;
  if (mode === "demo") schedule = (await seedDemoSchedule(now)).length;
  else if (vaultId) {
    const sandbox = await seedSandboxSchedule({ vaultId });
    for (const line of sandbox.lines.filter((l) => l.stopped)) console.error(`Demo reset: the schedule seed stopped ${line.scenario.name}: ${line.stopped}`);
    schedule = sandbox.lines.filter((l) => l.rentalId).length;
  }
  const insights = mode === "demo" ? await seedInsightsHistory(now) : [];
  publish("demo-reset", "demo.reset");
  return {
    mode,
    deletedRentals,
    released,
    seeded: {
      counter: counter.lines.filter((l) => l.rentalId).length,
      schedule,
      insights: insights.length,
      ...(counter.skipped ? { note: counter.skipped } : {}),
    },
  };
}

/**
 * Voids every deposit hold that is still open, best effort: a refusal is
 * logged and the reset goes on, since the rentals are deleted either way and
 * PayPal lets an unused hold expire. The request id is derived from the
 * rental and the authorization, so a retried reset does not void twice.
 */
async function releaseOpenHolds(gateway: DepositGateway): Promise<HoldRelease[]> {
  const db = await getDb();
  const rows = await db.query<{ id: string; authorization_id: string }>(
    "select id, authorization_id from rentals where authorization_id is not null and settled_at is null and status = any($1) order by created_at",
    [HOLDING],
  );
  const results: HoldRelease[] = [];
  for (const row of rows) {
    const requestId = `reset-void:${row.id}:${row.authorization_id}`;
    try {
      await gateway.release(row.authorization_id, requestId);
      console.log(`Demo reset: voided the deposit hold ${row.authorization_id} of ${row.id}.`);
      results.push({ rentalId: row.id, authorizationId: row.authorization_id, requestId, outcome: "voided" });
    } catch (err) {
      const detail = PayPalError.is(err)
        ? `${err.issue ?? err.errorName}${err.debugId ? ` (PayPal debug_id ${err.debugId})` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
      console.error(`Demo reset: could not void the deposit hold ${row.authorization_id} of ${row.id}: ${detail}`);
      results.push({ rentalId: row.id, authorizationId: row.authorization_id, requestId, outcome: "failed", detail });
    }
  }
  return results;
}

/** When the last reset finished, for /api/health. */
export async function lastDemoReset(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<{ finished_at: unknown }>("select finished_at from demo_resets where status = 'done' order by finished_at desc limit 1");
  return rows[0] ? iso(rows[0].finished_at) : null;
}
