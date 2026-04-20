import { test, expect } from "@playwright/test";
import { createTemplate, uniq } from "./_helpers";

test("templates page lists a template created via API", async ({ page, request }) => {
  const name = uniq("tmpl-e2e");
  await createTemplate(request, name);

  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("templates page calls GET /templates on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/templates(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/templates");
  const res = await listed;
  expect(res.status()).toBe(200);
});
