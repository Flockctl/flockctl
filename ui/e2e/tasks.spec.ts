import { test, expect } from "@playwright/test";
import { createProject, createTask, uniq } from "./_helpers";

test("tasks page renders list after a task is created", async ({ page, request }) => {
  const proj = await createProject(request, uniq("tasks-list"));
  const task = await createTask(request, proj.id);

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  const shortId = String(task.id).slice(0, 8);
  await expect(page.getByText(shortId, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
});

test("tasks page calls GET /tasks on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/tasks(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/tasks");
  const res = await listed;
  expect(res.status()).toBe(200);
});

test("task detail page is reachable from /tasks/:id", async ({ page, request }) => {
  const proj = await createProject(request, uniq("tasks-detail"));
  const task = await createTask(request, proj.id, { prompt: "jump-to-detail-prompt" });

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("jump-to-detail-prompt").first()).toBeVisible({
    timeout: 10_000,
  });
});
