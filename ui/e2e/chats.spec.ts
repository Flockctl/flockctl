import { test, expect } from "@playwright/test";
import { createWorkspace, uniq } from "./_helpers";

test("chats page renders and lists a chat created via API", async ({ page, request }) => {
  const ws = await createWorkspace(request);
  const title = uniq("chat");
  const res = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(res.status());

  await page.goto("/chats");
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
});

test("chats page shows new chat button", async ({ page }) => {
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /New Chat/i }).first()).toBeVisible();
});
