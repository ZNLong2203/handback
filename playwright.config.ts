import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a server in demo mode (PayPal stand-in,
 * recorded Gemini replies, in-memory database), so they need no keys.
 *   npm run e2e            # builds and starts the server itself on port 3200
 *   E2E_PORT=3305 npm run e2e                        # the same, on another port
 *   E2E_BASE_URL=http://localhost:3100 npm run e2e   # reuse a running one
 * On CI the run also writes an HTML report to playwright-report/.
 */
const port = Number(process.env.E2E_PORT || 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: ci,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run build && npx next start -p ${port}`,
        url: baseURL,
        timeout: 240_000,
        reuseExistingServer: false,
        env: { DEMO_MODE: "true", DATABASE_URL: "memory", APP_URL: baseURL },
      },
});
