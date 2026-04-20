import { test, expect } from "@playwright/test";
import { createProject, createTask } from "./_helpers";

test("task detail page renders after task creation", async ({ page, request }) => {
  const proj = await createProject(request);
  const task = await createTask(request, proj.id, { prompt: "task-detail-check" });

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("Prompt").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("task-detail-check").first()).toBeVisible();
});
