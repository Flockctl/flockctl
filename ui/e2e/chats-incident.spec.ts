// e2e: select N chat messages → click "Save as incident" → dialog opens with
// (possibly blank) pre-filled fields → user fills the title → Save → incident
// is persisted to the /incidents table.
//
// In e2e the daemon runs without AI provider keys, so the extractor short-
// circuits and returns an empty draft. That's the intended "fallback when the
// LLM can't help" path — the user can still save manually. The assertion we
// care about is the end state: a new incident record exists with the chat id
// we created it from.

import { test, expect } from "@playwright/test";
import { createWorkspace, uniq } from "./_helpers";

test("select 2 messages → save as incident → incident is created", async ({ page, request }) => {
  const ws = await createWorkspace(request);
  const title = uniq("chat");

  // Seed a chat via the API so the UI has something to render without making
  // any real LLM calls (the daemon in e2e has no keys).
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = await chatRes.json();
  const chatId = chat.id as number;

  // Seed two messages by hitting POST /chats/:id/messages with a non-"user"
  // role. The handler short-circuits in that case (role !== "user"), so the
  // rows land in the DB without triggering any AI executor — exactly what we
  // need for an e2e that doesn't have provider keys configured.
  const seedMessages = [
    { role: "system", content: "Symptom: 502 on /api/auth after restart" },
    { role: "assistant", content: "Root cause: expired client cert" },
  ];
  for (const m of seedMessages) {
    const res = await request.post(`/chats/${chatId}/messages`, { data: m });
    expect([200, 201]).toContain(res.status());
  }

  // Navigate to the chat detail view.
  await page.goto(`/chats/${chatId}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });

  // Enter multi-select mode from the chat header.
  await page.getByTestId("chat-select-mode-toggle").click();

  // All message rows are now selectable — pick the first two checkboxes.
  const checkboxes = page.getByTestId("chat-message-checkbox");
  await expect(checkboxes.first()).toBeVisible({ timeout: 5_000 });
  const count = await checkboxes.count();
  expect(count).toBeGreaterThanOrEqual(2);
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();

  // Action bar should appear once >=1 message is selected.
  await expect(page.getByTestId("chat-action-bar")).toBeVisible();

  // Click "Save as incident" → dialog opens.
  await page.getByTestId("chat-save-as-incident").click();
  await expect(page.getByTestId("save-as-incident-dialog")).toBeVisible();

  // Dialog fields are present and editable. With no API keys set, the
  // extractor returns an empty draft — the form stays blank and we fill it.
  const titleInput = page.getByTestId("incident-title");
  await expect(titleInput).toBeVisible();
  const incidentTitle = uniq("incident");
  await titleInput.fill(incidentTitle);

  await page.getByTestId("incident-symptom").fill("502 on /api/auth after restart");

  // Save.
  await page.getByTestId("incident-save-button").click();

  // Dialog closes — a successful POST flips open=false.
  await expect(page.getByTestId("save-as-incident-dialog")).not.toBeVisible({ timeout: 10_000 });

  // Verify the incident was persisted via the API.
  const listRes = await request.get("/incidents?per_page=50");
  expect(listRes.status()).toBe(200);
  const list = (await listRes.json()) as {
    items: Array<{ id: number; title: string; createdByChatId: number | null }>;
  };
  const created = list.items.find((i) => i.title === incidentTitle);
  expect(created).toBeDefined();
  expect(created?.createdByChatId).toBe(chatId);
});
