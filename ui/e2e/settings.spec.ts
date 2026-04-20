import { test, expect } from "@playwright/test";

test("settings page shows AI Provider Keys section", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("AI Provider Keys").first()).toBeVisible();
});

test("settings page calls GET /keys on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/keys(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/settings");
  const res = await listed;
  expect(res.status()).toBe(200);
});
