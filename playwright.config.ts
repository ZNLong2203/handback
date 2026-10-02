import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against servers in demo mode (PayPal stand-in,
 * recorded Gemini replies, in-memory database), so they need no keys. The
 * schedule spec gets a server of its own on the next port: it checks the
 * layout of the demo schedule, which the other specs' bookings would change.
 *   npm run e2e            # builds and starts the servers itself on ports 3200 and 3201
 *   E2E_PORT=3305 npm run e2e                        # the same, on 3305 and 3306
 *   E2E_BASE_URL=http://localhost:3100 npm run e2e   # reuse one running server for every spec
 * On CI the run also writes an HTML report to playwright-report/.
 */
const port = Number(process.env.E2E_PORT || 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
const scheduleURL = process.env.E2E_BASE_URL ?? `http://localhost:${port + 1}`;
const ci = Boolean(process.env.CI);
const demo = (url: string) => ({ DEMO_MODE: "true", DATABASE_URL: "memory", APP_URL: url });

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: ci,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /schedule\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "schedule", testMatch: /schedule\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: scheduleURL } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: `npm run build && npx next start -p ${port}`,
          url: baseURL,
          timeout: 240_000,
          reuseExistingServer: false,
          env: demo(baseURL),
        },
        {
          // Starts once the first server answers, so the build is finished.
          command: `until curl -sf -o /dev/null ${baseURL}; do sleep 1; done; npx next start -p ${port + 1}`,
          url: scheduleURL,
          timeout: 240_000,
          reuseExistingServer: false,
          env: demo(scheduleURL),
        },
      ],
});
