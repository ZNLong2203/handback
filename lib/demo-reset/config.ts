import type { PayPalMode } from "@/lib/paypal/config";
import { parseResetHour } from "@/scripts/cron/demo-reset-hour.mjs";

export { resetDayOf } from "@/scripts/cron/demo-reset-hour.mjs";

/** Environment variables, as process.env or a test's own. */
export type Env = Record<string, string | undefined>;

export type DemoResetConfig = {
  /** DEMO_RESET is "true". Off by default: the reset deletes every rental. */
  enabled: boolean;
  /** DEMO_RESET_HOUR, the hour in UTC the cron job asks for the reset. */
  hourUtc: number;
  /** Why the reset must not run here at all, even when enabled. */
  refusal: string | null;
};

const LIVE_REFUSAL = "PAYPAL_ENVIRONMENT is live. The demo reset deletes every rental, so it never runs against live PayPal.";

/** The nightly demo reset's settings, from the same variables the cron job reads. */
export function demoResetConfig(env: Env = process.env): DemoResetConfig {
  return {
    enabled: env.DEMO_RESET === "true",
    hourUtc: parseResetHour(env.DEMO_RESET_HOUR).hour,
    refusal: env.PAYPAL_ENVIRONMENT === "live" ? LIVE_REFUSAL : null,
  };
}

/** The refusal for a gateway in live mode, whatever PAYPAL_ENVIRONMENT says. */
export const liveRefusal = (mode: PayPalMode): string | null => (mode === "live" ? LIVE_REFUSAL : null);

/**
 * The saved sandbox wallet the reset seeds the counter with: SEED_VAULT_ID,
 * as for `npm run seed:demo`, but never "latest". On a public demo the newest
 * wallet saved at a booking may be a visitor's, and the seed charges it.
 */
export function resetSeedWallet(mode: PayPalMode, env: Env = process.env): string | undefined {
  const id = env.SEED_VAULT_ID?.trim();
  return mode === "sandbox" && id && id !== "latest" ? id : undefined;
}

/** Whether the reset books sample rentals again after the wipe: always in demo mode, with a saved wallet in the sandbox. */
export function resetReseeds(mode: PayPalMode, env: Env = process.env): boolean {
  return mode === "demo" || Boolean(resetSeedWallet(mode, env));
}

/** The next time the reset hour starts, from `now`. */
export function nextResetAt(now: Date, hourUtc: number): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  return today > now ? today : new Date(today.getTime() + 86_400_000);
}

const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" });

/**
 * The reset time in words: "20:00 UTC", the same moment in California (where
 * it moves with daylight saving time), and how long until the next one. The
 * cron job runs at 17 minutes past the hour, so the reset lands a little
 * after the hour.
 */
export function resetTimeLabel(hourUtc: number, now: Date): { utc: string; pacific: string; until: string } {
  const next = nextResetAt(now, hourUtc);
  const hours = (next.getTime() - now.getTime()) / 3_600_000;
  const rounded = Math.round(hours);
  return {
    utc: `${String(hourUtc).padStart(2, "0")}:00 UTC`,
    pacific: `${pacific.format(next)} Pacific`,
    until: hours < 1 ? "next in under an hour" : `next in about ${rounded} ${rounded === 1 ? "hour" : "hours"}`,
  };
}
