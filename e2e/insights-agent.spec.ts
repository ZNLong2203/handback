import { expect, test } from "@playwright/test";

// The deposit desk agent in the browser, end to end: AG Studio's chat panel,
// its harness and our adapter, the staff-only turn route, the agent's own
// tool on the server, and the tool's card in the panel. The e2e server
// answers turns from a fixed script instead of Gemini (INSIGHTS_AGENT_SCRIPT,
// lib/insights/llm.ts), so no key is needed and no model is called.

test("the deposit desk calls its holds tool through Studio and answers from the result", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/shop/insights");
  const scripted = page.getByText("Deposit desk agent on a test script");
  test.skip(!(await scripted.isVisible()), "This server runs without the test script (E2E_BASE_URL), so the agent is not scripted.");

  await page.getByRole("button", { name: "Edit and ask the deposit desk" }).click();
  await page.getByText("Holds needing attention", { exact: true }).first().click();

  // Studio ran the tool the script asked for, through /api/insights/tools, and drew its card.
  await expect(page.getByText("Checked the running holds")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^\d+ of \d+ need you$/)).toBeVisible();
  // The second turn read the tool's result.
  await expect(page.getByText(/^Test script: \d+ running holds? needs? a person now\.$/)).toBeVisible();
});
