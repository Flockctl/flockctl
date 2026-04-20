import { test, expect } from "@playwright/test";

const topLevelPages: Array<{ path: string; heading: RegExp }> = [
  { path: "/dashboard", heading: /Dashboard|Tasks|Projects/i },
  { path: "/tasks", heading: /^Tasks$/ },
  { path: "/templates", heading: /^Templates$/ },
  { path: "/schedules", heading: /^Schedules$/ },
  { path: "/projects", heading: /^Projects$/ },
  { path: "/workspaces", heading: /^Workspaces$/ },
  { path: "/analytics", heading: /^Analytics$/ },
  { path: "/settings", heading: /^Settings$/ },
  { path: "/skills-mcp", heading: /Skills & MCP/i },
];

for (const { path, heading } of topLevelPages) {
  test(`navigation: ${path} renders without crashing`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({
      timeout: 10_000,
    });
    expect(errors, `uncaught exceptions on ${path}`).toEqual([]);
  });
}

test("root redirects to /dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);
});
