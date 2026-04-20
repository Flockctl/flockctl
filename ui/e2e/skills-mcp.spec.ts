import { test, expect } from "@playwright/test";

test("skills-mcp page renders heading", async ({ page }) => {
  await page.goto("/skills-mcp");
  await expect(page.getByRole("heading", { name: /Skills & MCP/i })).toBeVisible();
});
