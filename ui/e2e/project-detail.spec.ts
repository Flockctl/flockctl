import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

test("project detail page renders project name", async ({ page, request }) => {
  const name = uniq("proj-detail");
  const proj = await createProject(request, name);

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("project settings page shows General and AI Configuration", async ({ page, request }) => {
  const proj = await createProject(request);

  await page.goto(`/projects/${proj.id}/settings`);
  await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("General").first()).toBeVisible();
  await expect(page.getByText("AI Configuration").first()).toBeVisible();
});
