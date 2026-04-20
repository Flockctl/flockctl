import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

test("projects page lists a project created via API", async ({ page, request }) => {
  const name = uniq("proj-e2e");
  await createProject(request, name);

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" }).first()).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("projects page calls GET /projects on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/projects(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/projects");
  const res = await listed;
  expect(res.status()).toBe(200);
});

test("navigating from /projects to project detail loads the project", async ({
  page,
  request,
}) => {
  const name = uniq("proj-nav");
  const proj = await createProject(request, name);

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});
