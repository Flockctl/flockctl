import { test, expect } from "@playwright/test";

test("analytics page loads and calls /metrics on render", async ({ page }) => {
  const metricsRequested = page.waitForResponse(
    (r) => r.url().includes("/metrics") && r.request().method() === "GET",
  );
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics" }).first()).toBeVisible();
  const res = await metricsRequested;
  expect(res.status()).toBe(200);
});

test("analytics page calls /keys endpoint on render", async ({ page }) => {
  const keysRequested = page.waitForResponse(
    (r) => /\/keys(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/analytics");
  const res = await keysRequested;
  expect(res.status()).toBe(200);
});
