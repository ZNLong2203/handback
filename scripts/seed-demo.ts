/**
 * Gives a fresh deployment a lived-in counter: six rentals walked through the
 * real rental service to different steps (booked, out, needs review, with the
 * customer, settled clean, settled with a charge).
 *
 *   npm run seed:demo                              # demo mode: the PayPal stand-in
 *   SEED_VAULT_ID=<vault id> npm run seed:demo     # sandbox: real sandbox payments
 *   SEED_VAULT_ID=latest npm run seed:demo         # the newest wallet saved at a booking
 *
 * Safe to run again: each rental is found by its customer's email and only
 * the missing steps run. It refuses to run against live PayPal. On Render it
 * runs once after the web service's first deploy (initialDeployHook in
 * render.yaml), and from the service's Shell tab after that.
 */
import { paypalConfig } from "@/lib/paypal/config";
import { aiConfigured } from "@/lib/inspection/run";
import { latestSavedWallet, seedCounter } from "@/lib/seed/run";
import { workflowsConfig } from "@/lib/workflows/config";

const jobs = workflowsConfig();
console.log(
  `Seeding the counter. PayPal: ${paypalConfig().mode}. AI: ${aiConfigured() ? "Gemini, live" : "recorded replies"}. Inspections: ${jobs.runner === "render" ? "Render Workflows" : "in this process"}.`,
);

const requested = process.env.SEED_VAULT_ID?.trim() || undefined;
const vaultId = requested === "latest" ? ((await latestSavedWallet()) ?? undefined) : requested;
if (requested === "latest") console.log(vaultId ? `Using the newest saved wallet: ${vaultId}` : "No booking has saved a wallet yet.");
const report = await seedCounter({ vaultId });
if (report.skipped) console.log(report.skipped);
for (const line of report.lines) {
  const what = line.stopped ? `stopped: ${line.stopped}` : line.ran.length ? `ran ${line.ran.join(", ")}` : "already there";
  console.log(`  ${(line.rentalId ?? "-").padEnd(9)} ${line.scenario.name.padEnd(12)} ${line.scenario.itemId.padEnd(15)} ${(line.status ?? "-").padEnd(16)} ${what}`);
}
if (report.mode === "demo" && report.lines.some((l) => l.ran.length)) {
  console.log(
    "Demo mode: the PayPal stand-in caches its state in the web process. If the web service has already booked or held anything since it started, restart it so it reads the seeded state.",
  );
}
// The database pool would keep the process alive.
process.exit(0);
