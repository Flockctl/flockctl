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

/**
 * Minimal 1×1 PNG — magic-byte-valid so the backend's sniff check passes.
 * Anything smaller than 12 bytes would be rejected outright; this is the
 * smallest well-formed PNG we can ship inline.
 */
const ONE_PX_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
    "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

test("composer uploads an image and sends it with attachment_ids[]", async ({ page, request }) => {
  // Seed a chat directly — no real LLM calls needed for this test; we only
  // care that the composer (a) uploads via POST /chats/:id/attachments,
  // (b) surfaces the result as a chip, and (c) threads the numeric
  // attachment id into the stream POST body on send.
  const ws = await createWorkspace(request);
  const title = uniq("chat-upload");
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };
  const chatId = chat.id;

  // Intercept the streaming endpoint so we (1) capture the serialized body
  // to assert on, and (2) return a short, valid SSE stream so the composer's
  // send flow resolves without waiting on a live AI key (none in e2e).
  let capturedBody: {
    content?: string;
    attachment_ids?: unknown;
  } | null = null;
  await page.route(`**/chats/${chatId}/messages/stream`, async (route) => {
    capturedBody = route.request().postDataJSON() as typeof capturedBody;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      body: `data: {"content":"ok"}\n\ndata: {"done":true}\n\n`,
    });
  });

  await page.goto(`/chats/${chatId}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });

  // The composer renders a hidden <input type="file"> driven by the paperclip
  // button — Playwright's setInputFiles hits it directly so we don't have to
  // chase the native file-chooser dialog.
  const fileInput = page.getByTestId("chat-composer-file-input");
  await fileInput.setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: ONE_PX_PNG,
  });

  // Chip should transition to `ready` once the POST returns (no AI key
  // required — attachments are a plain DB insert + disk write).
  const chip = page.getByTestId("attachment-chip").first();
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 5_000 });

  // Type a message and click Send.
  const textarea = page.getByTestId("chat-composer-textarea");
  await textarea.fill("look at this image");
  await page.getByTestId("chat-composer-send").click();

  // Stream handler captures the body — assert the content and the numeric
  // attachment id array made it onto the wire.
  await expect
    .poll(() => capturedBody?.content, { timeout: 5_000 })
    .toBe("look at this image");
  const ids = capturedBody?.attachment_ids;
  expect(Array.isArray(ids)).toBe(true);
  expect((ids as number[]).length).toBe(1);
  expect(typeof (ids as number[])[0]).toBe("number");

  // Chips clear after a successful send.
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("todo history drawer renders tabs per agent and expands older snapshots on demand", async ({ page, request }) => {
  // Seed a chat — the TodoWrite snapshot endpoint is what drives the progress
  // bar + History button visibility, so we route those two endpoints to
  // canned payloads. That keeps the test hermetic: no live agent run
  // required to populate chat_todos.
  const ws = await createWorkspace(request);
  const title = uniq("chat-history");
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };
  const chatId = chat.id;

  // Latest snapshot — unlocks the progress bar + History button.
  await page.route(`**/chats/${chatId}/todos`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          id: 2,
          createdAt: "2026-04-20T10:00:00.000Z",
          todos: [{ content: "Ship it", status: "in_progress" }],
        },
        counts: { total: 2, completed: 1, inProgress: 1, pending: 0 },
      }),
    });
  });

  // Per-agent grouping — main agent + one sub-agent. Drives the tab strip.
  // `completedAt` is the wire field name (apiFetch converts to `completed_at`
  // on the way into the UI types).
  await page.route(`**/chats/${chatId}/todos/agents`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            key: "main",
            parentToolUseId: null,
            label: "Main agent",
            subagentType: null,
            snapshotCount: 2,
            latest: {
              id: 2,
              createdAt: "2026-04-20T10:00:00.000Z",
              todos: [
                {
                  content: "Design drawer",
                  status: "completed",
                  completedAt: "2026-04-20T10:00:00.000Z",
                },
                { content: "Ship it", status: "in_progress", completedAt: null },
              ],
              counts: { total: 2, completed: 1, inProgress: 1, pending: 0 },
            },
          },
          {
            key: "toolu_sub_a",
            parentToolUseId: "toolu_sub_a",
            label: "tester-1",
            subagentType: "general-purpose",
            snapshotCount: 1,
            latest: {
              id: 3,
              createdAt: "2026-04-20T10:05:00.000Z",
              todos: [
                { content: "Run unit suite", status: "pending", completedAt: null },
              ],
              counts: { total: 1, completed: 0, inProgress: 0, pending: 1 },
            },
          },
        ],
      }),
    });
  });

  // History route — agent-scoped pagination. Returns a fixture that includes
  // the latest (which the drawer trims off the front) plus one older.
  await page.route(`**/chats/${chatId}/todos/history**`, async (route) => {
    const url = new URL(route.request().url());
    const agent = url.searchParams.get("agent") ?? "main";
    if (agent === "main") {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              id: 2,
              createdAt: "2026-04-20T10:00:00.000Z",
              parentToolUseId: null,
              todos: [
                { content: "Design drawer", status: "completed" },
                { content: "Ship it", status: "in_progress" },
              ],
              counts: { total: 2, completed: 1, inProgress: 1, pending: 0 },
            },
            {
              id: 1,
              createdAt: "2026-04-20T09:00:00.000Z",
              parentToolUseId: null,
              todos: [{ content: "Design drawer", status: "pending" }],
              counts: { total: 1, completed: 0, inProgress: 0, pending: 1 },
            },
          ],
          total: 2,
          page: 1,
          perPage: 20,
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              id: 3,
              createdAt: "2026-04-20T10:05:00.000Z",
              parentToolUseId: agent,
              todos: [{ content: "Run unit suite", status: "pending" }],
              counts: { total: 1, completed: 0, inProgress: 0, pending: 1 },
            },
          ],
          total: 1,
          page: 1,
          perPage: 20,
        }),
      });
    }
  });

  await page.goto(`/chats/${chatId}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });

  const historyBtn = page.getByTestId("todo-history-button");
  await expect(historyBtn).toBeVisible({ timeout: 5_000 });
  await historyBtn.click();

  // Drawer opens; one tab per agent (main + tester-1).
  const drawer = page.getByTestId("todo-history-drawer");
  await expect(drawer).toBeVisible();
  const tabs = page.getByTestId("todo-history-tab");
  await expect(tabs).toHaveCount(2);
  // First tab (main) is auto-selected — its label is "Main agent" and the
  // latest snapshot's "Design drawer" todo carries a per-todo completion
  // timestamp.
  await expect(tabs.first()).toContainText("Main agent");
  await expect(
    page.getByTestId("todo-history-latest").getByTestId("todo-completed-at"),
  ).toBeVisible();

  // Older snapshots collapsible: count is snapshotCount - 1 (2 - 1 = 1) for
  // main. Toggle and confirm the older snapshot list mounts.
  const older = page.getByTestId("todo-history-older-toggle");
  await expect(older).toContainText("Older snapshots (1)");
  await older.click();
  await expect(page.getByTestId("todo-history-older-list")).toBeVisible();
  await expect(page.getByTestId("todo-history-item")).toHaveCount(1);

  // Switch to the sub-agent tab — different latest snapshot renders, sub-agent
  // type chip surfaces, and (snapshotCount=1 for sub) no Older toggle appears.
  await tabs.nth(1).click();
  await expect(page.getByTestId("todo-history-content")).toContainText(
    "Run unit suite",
  );
  await expect(page.getByTestId("todo-history-older-toggle")).toHaveCount(0);
});

test("todo history button is hidden when no snapshots exist", async ({ page, request }) => {
  // A freshly-created chat has no chat_todos rows — the `/chats/:id/todos`
  // endpoint responds 204, the progress bar stays gated, and the History
  // button must NOT render. Guarding this keeps the empty-state promise.
  const ws = await createWorkspace(request);
  const title = uniq("chat-no-history");
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };

  await page.goto(`/chats/${chat.id}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("todo-history-button")).toHaveCount(0);
});

test("composer rejects oversized non-image files client-side", async ({ page, request }) => {
  const ws = await createWorkspace(request);
  const title = uniq("chat-reject");
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };

  await page.goto(`/chats/${chat.id}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });

  // A text/plain blob must be rejected before any network call. The chip
  // list therefore stays empty and the composer surfaces a reason.
  await page.getByTestId("chat-composer-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });

  await expect(page.getByTestId("chat-composer-error")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});
