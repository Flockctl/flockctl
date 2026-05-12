import { test, expect, type Page } from "@playwright/test";
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
  await expect(page.getByRole("button", { name: /New[\s-]?chat/i }).first()).toBeVisible();
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

// ---------------------------------------------------------------------------
// Visual baselines (slice 24-02 T04).
//
// Page assembly: SectionHeader → ChatsToolbar → ChatsList. Baselines cover
// list/grouped × light/dark + initial empty + filtered empty.
//
// Each variant intercepts /chats at the daemon origin so the baseline does
// not drift as the e2e backend accumulates seeded rows. Theme is pinned via
// localStorage before navigation so the dark baseline doesn't fight the OS
// preference of the testing host. `?group=project` toggles the grouped
// section view; `?q=__no_match__` exercises the filtered-empty branch.
// ---------------------------------------------------------------------------

async function freezeChatsAnimations(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}

async function pinChatsTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

const CHATS_FIXTURE_NOW = "2025-01-01T00:00:00.000Z";

interface ChatsFixtureChat {
  id: string;
  user_id: string;
  project_id: string | null;
  workspace_id: string | null;
  project_name: string | null;
  workspace_name: string | null;
  title: string;
  entity_type: string | null;
  entity_id: string | null;
  permission_mode: null;
  ai_provider_key_id: null;
  model: null;
  thinking_enabled: boolean;
  effort: null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  is_streaming: boolean;
  metrics: {
    message_count: number;
    user_message_count: number;
    assistant_message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    total_copilot_quota: number;
    last_message_at: string | null;
    last_message_excerpt: string | null;
    todos_counts: null;
  };
}

function makeFixtureChat(
  overrides: Partial<ChatsFixtureChat> & { id: string; title: string },
): ChatsFixtureChat {
  return {
    user_id: "u-1",
    project_id: null,
    workspace_id: null,
    project_name: null,
    workspace_name: null,
    entity_type: null,
    entity_id: null,
    permission_mode: null,
    ai_provider_key_id: null,
    model: null,
    thinking_enabled: true,
    effort: null,
    pinned: false,
    created_at: CHATS_FIXTURE_NOW,
    updated_at: CHATS_FIXTURE_NOW,
    is_streaming: false,
    metrics: {
      message_count: 4,
      user_message_count: 2,
      assistant_message_count: 2,
      total_input_tokens: 1200,
      total_output_tokens: 800,
      total_cost_usd: 0.04,
      total_copilot_quota: 0,
      last_message_at: CHATS_FIXTURE_NOW,
      last_message_excerpt: "Sounds good — let's split the milestone view first.",
      todos_counts: null,
    },
    ...overrides,
  };
}

const FIXTURE_CHATS: ChatsFixtureChat[] = [
  makeFixtureChat({
    id: "fc-alpha",
    title: "Refactor the planner",
    project_name: "flockctl",
    project_id: "1",
    is_streaming: true,
    metrics: {
      message_count: 8,
      user_message_count: 4,
      assistant_message_count: 4,
      total_input_tokens: 4800,
      total_output_tokens: 2200,
      total_cost_usd: 0.12,
      total_copilot_quota: 0,
      last_message_at: "2025-01-01T03:00:00.000Z",
      last_message_excerpt: "Editing src/services/plan-store/milestones.ts to thread the new flag.",
      todos_counts: null,
    },
    updated_at: "2025-01-01T03:00:00.000Z",
  }),
  makeFixtureChat({
    id: "fc-beta",
    title: "Marketing site copy review",
    project_name: "marketing-site",
    project_id: "2",
    metrics: {
      message_count: 5,
      user_message_count: 3,
      assistant_message_count: 2,
      total_input_tokens: 1800,
      total_output_tokens: 1000,
      total_cost_usd: 0.05,
      total_copilot_quota: 0,
      last_message_at: "2025-01-01T02:00:00.000Z",
      last_message_excerpt: "Tighten the headline — three options below, ranked by punch.",
      todos_counts: null,
    },
    updated_at: "2025-01-01T02:00:00.000Z",
  }),
  makeFixtureChat({
    id: "fc-gamma",
    title: "Docs revamp",
    workspace_name: "personal",
    workspace_id: "9",
    metrics: {
      message_count: 3,
      user_message_count: 2,
      assistant_message_count: 1,
      total_input_tokens: 900,
      total_output_tokens: 600,
      total_cost_usd: 0.02,
      total_copilot_quota: 0,
      last_message_at: "2025-01-01T01:00:00.000Z",
      last_message_excerpt: "Move the conceptual docs above the API reference.",
      todos_counts: null,
    },
    updated_at: "2025-01-01T01:00:00.000Z",
  }),
  makeFixtureChat({
    id: "fc-delta",
    title: "Standalone scratch",
    metrics: {
      message_count: 1,
      user_message_count: 1,
      assistant_message_count: 0,
      total_input_tokens: 120,
      total_output_tokens: 0,
      total_cost_usd: 0.001,
      total_copilot_quota: 0,
      last_message_at: "2025-01-01T00:30:00.000Z",
      last_message_excerpt: "Quick experiment with the new chat list grouping.",
      todos_counts: null,
    },
    updated_at: "2025-01-01T00:30:00.000Z",
  }),
];

async function stubChatsList(page: Page, chats: ChatsFixtureChat[] = FIXTURE_CHATS) {
  // The SPA's apiFetch always targets the daemon at 127.0.0.1:<E2E_BACKEND_PORT>.
  // Pinning route handlers to that origin avoids shadowing the dev server's
  // SPA HTML responses on /chats (a bare `**/chats` glob would also catch
  // `http://localhost:5174/chats`, the page navigation itself).
  const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
  const apiOrigin = `http://127.0.0.1:${backendPort}`;

  const respond = async (route: import("@playwright/test").Route, payload: unknown) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  };

  const handleChats = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: chats, total: chats.length, page: 1, perPage: 50 });
      return;
    }
    await route.fallback();
  };

  await page.route(`${apiOrigin}/chats`, handleChats);
  await page.route(`${apiOrigin}/chats?**`, handleChats);

  // Quiet the live-pending seed and the projects/workspaces dialog
  // dropdowns so the screenshot doesn't flicker on whatever the seeded
  // backend currently holds.
  await page.route(`${apiOrigin}/chats/pending-permissions`, async (route) => {
    await respond(route, { pending: {}, running: [] });
  });
  await page.route(`${apiOrigin}/projects`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: [], total: 0 });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/projects?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: [], total: 0 });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/workspaces`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: [], total: 0 });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/workspaces?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: [], total: 0 });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/attention*`, async (route) => {
    await respond(route, { items: [] });
  });
}

test.describe("chats page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`list layout — ${theme}`, async ({ page }) => {
      await pinChatsTheme(page, theme);
      await stubChatsList(page);
      await page.goto("/chats");
      await expect(
        page.getByTestId("chats-page").getByRole("heading", { name: "Chats", level: 1 }),
      ).toBeVisible();
      await expect(page.getByTestId("chats-list")).toBeVisible({ timeout: 10_000 });
      // At least one row from the fixture must render before we snap.
      await expect(page.getByTestId("chat-row").first()).toBeVisible();
      await freezeChatsAnimations(page);
      await expect(page).toHaveScreenshot(`chats-list-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`grouped layout — ${theme}`, async ({ page }) => {
      await pinChatsTheme(page, theme);
      await stubChatsList(page);
      await page.goto("/chats?group=project");
      await expect(
        page.getByTestId("chats-page").getByRole("heading", { name: "Chats", level: 1 }),
      ).toBeVisible();
      await expect(page.getByTestId("chats-list")).toHaveAttribute(
        "data-group",
        "project",
        { timeout: 10_000 },
      );
      await expect(page.getByTestId("chats-list-section").first()).toBeVisible();
      await freezeChatsAnimations(page);
      await expect(page).toHaveScreenshot(`chats-grouped-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test("empty baseline — no chats yet", async ({ page }) => {
    await pinChatsTheme(page, "light");
    await stubChatsList(page, []);
    await page.goto("/chats");
    await expect(
      page.getByTestId("chats-page").getByRole("heading", { name: "Chats", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("chats-empty-state")).toBeVisible({
      timeout: 10_000,
    });
    await freezeChatsAnimations(page);
    await expect(page).toHaveScreenshot("chats-empty.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("filtered empty baseline — ?q=__no_match__", async ({ page }) => {
    await pinChatsTheme(page, "light");
    await stubChatsList(page);
    await page.goto(`/chats?q=${encodeURIComponent("__zzz_no_match_zzz__")}`);
    await expect(
      page.getByTestId("chats-page").getByRole("heading", { name: "Chats", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("chats-filtered-empty-state")).toBeVisible({
      timeout: 10_000,
    });
    await freezeChatsAnimations(page);
    await expect(page).toHaveScreenshot("chats-filtered-empty.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
