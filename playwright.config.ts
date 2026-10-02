import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a server in demo mode (PayPal stand-in,
 * recorded Gemini replies, in-memory database), so they need no keys.
 *   npm run e2e            # starts the server itself
 *   E2E_BASE_URL=http://localhost:3100 npm run e2e   # reuse a running one
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npx next start -p 3200",
        url: baseURL,
        timeout: 240_000,
        reuseExistingServer: false,
        env: { DEMO_MODE: "true", DATABASE_URL: "memory", APP_URL: baseURL },
      },
});
