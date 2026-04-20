import { test, expect } from "@playwright/test";

test("dashboard renders main landmarks", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText(/Tasks/i).first()).toBeVisible();
  await expect(page.getByText(/Projects/i).first()).toBeVisible();
});

test("dashboard calls backend endpoints on load", async ({ page }) => {
  const anyResponse = page.waitForResponse(
    (r) => r.status() === 200 && /\/(tasks|projects|metrics|usage)/.test(r.url()),
  );
  await page.goto("/dashboard");
  await anyResponse;
});

test("root path redirects to /dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);
});
