import { test, expect } from "@playwright/test";
import { createWorkspace, uniq } from "./_helpers";

test("workspaces page lists a workspace created via API", async ({ page, request }) => {
  const name = uniq("ws-e2e");
  await createWorkspace(request, name);

  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("workspace detail page renders after navigation", async ({ page, request }) => {
  const name = uniq("ws-detail");
  const ws = await createWorkspace(request, name);

  await page.goto(`/workspaces/${ws.id}`);
  await expect(page.getByRole("heading", { name }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/Projects/i).first()).toBeVisible();
});

test("workspace settings page renders", async ({ page, request }) => {
  const ws = await createWorkspace(request);

  await page.goto(`/workspaces/${ws.id}/settings`);
  await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/General/i).first()).toBeVisible();
});
