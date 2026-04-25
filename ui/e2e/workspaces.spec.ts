import { test, expect, type Page, type Route } from "@playwright/test";
import { createWorkspace, uniq } from "./_helpers";

/**
 * Mock every endpoint the `/workspaces/:id` detail shell hydrates off so
 * the header-parity snapshot (below) is pixel-stable regardless of the
 * real e2e backend's clock or seed state.
 *
 *   GET /workspaces/:id            → useWorkspace
 *   GET /workspaces/:id/dashboard  → useWorkspaceDashboard
 *   GET /attention                 → useAttention (empty — header doesn't
 *                                    consume it but the reducer still runs)
 *   GET /chats?workspace_id=:id    → useChats (powers the Chat button's
 *                                    "jump to most recent" branch)
 *
 * The handler set is deliberately smaller than
 * {@link routeWorkspacesListEndpoints} — the workspace-detail header only
 * needs workspace + chats to settle into a non-Skeleton, non-"Creating…"
 * render. Tabs below the header may fan out to un-mocked endpoints and
 * render whatever the real backend returns; we crop the snapshot to just
 * the header so that noise can't reach the baseline.
 */
async function routeWorkspaceDetailEndpoints(
  page: Page,
  opts: {
    workspaceId: string;
    chats?: Array<{ id: string; title: string; updated_at: string }>;
  },
): Promise<void> {
  const { workspaceId, chats = [] } = opts;

  const workspace = {
    id: workspaceId,
    name: "Primary Workspace",
    description: null,
    path: "/tmp/primary",
    allowed_key_ids: [1],
    gitignore_flockctl: false,
    gitignore_todo: false,
    gitignore_agents_md: false,
    created_at: T_CREATED,
    updated_at: T_CREATED,
    projects: [],
  };

  const dashboard = {
    workspace_id: workspaceId,
    workspace_name: workspace.name,
    project_summaries: [],
    total_projects: 0,
    total_milestones: 0,
    active_milestones: 0,
    total_slices: 0,
    active_slices: 0,
    completed_slices: 0,
    running_tasks: 0,
    queued_tasks: 0,
    project_count: 0,
    active_tasks: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    pending_milestones: 0,
    active_milestones_count: 0,
    completed_milestones: 0,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    cost_by_project: [],
    recent_activity: [],
  };

  const chatItems = chats.map((c) => ({
    id: c.id,
    user_id: "user-1",
    project_id: null,
    workspace_id: workspaceId,
    project_name: null,
    workspace_name: workspace.name,
    title: c.title,
    entity_type: null,
    entity_id: null,
    permission_mode: null,
    ai_provider_key_id: null,
    model: null,
    thinking_enabled: true,
    effort: null,
    pinned: false,
    created_at: T_CREATED,
    updated_at: c.updated_at,
  }));

  const jsonBody = (o: unknown) => JSON.stringify(o);

  // Most specific first — `/workspaces/:id/dashboard` must intercept
  // before `/workspaces/:id` (which itself must intercept before
  // `/workspaces`). Playwright matches routes in registration order
  // (LIFO actually — last-registered wins), so register from least to
  // most specific so the specific handler is matched first.
  await page.route(/\/workspaces\/[^/?]+\/dependency-graph(\?[^/]*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ workspace_id: workspaceId, nodes: [], waves: [], errors: [] }),
    }),
  );
  await page.route(/\/workspaces\/[^/?]+\/dashboard(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody(dashboard),
    });
  });
  await page.route(/\/workspaces\/[^/?]+(\?[^/]*)?$/, async (route) => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody(workspace),
    });
  });
  await page.route(/\/attention(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items: [], total: 0 }),
    });
  });
  await page.route(/\/chats(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({
        items: chatItems,
        total: chatItems.length,
        offset: 0,
        limit: chatItems.length,
      }),
    });
  });
}

/**
 * Freeze every animation / transition / caret so pixel diffs across retries
 * don't flap on the Dialog fade-in or the Badge tone transition. Shared
 * helper for the two snapshot cases below.
 */
async function freeze(page: Page) {
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

/**
 * Fixed mock timestamps. Both specs below pair these with
 * `page.clock.install({ time: T_NOW })` so the row's "Xm ago" cell
 * renders the same string on every run regardless of wall-clock drift.
 * T_CREATED sits exactly 5 minutes before T_NOW → "5m ago".
 */
const T_NOW = "2026-04-23T10:00:00.000Z";
const T_CREATED = "2026-04-23T09:55:00.000Z";

interface MockedListOpts {
  /** Workspace id → attention item count. Items are synthesised. */
  attentionByWorkspace?: Record<string, number>;
  /** Extra workspaces on top of the default pair. */
  extraWorkspaces?: Array<{ id: string; name: string; path: string }>;
}

/**
 * Install `page.route` overrides for every endpoint the /workspaces list
 * view hydrates off:
 *
 *   GET /workspaces   → useWorkspaces
 *   GET /projects     → useProjects  (powers the project→workspace map
 *                                     the badge-count reducer walks)
 *   GET /attention    → useAttention (flat AttentionItem[] keyed on
 *                                     project_id; workspace-owned count
 *                                     is derived client-side)
 *   GET /keys         → useAIKeys   (CreateWorkspaceDialog mounts the
 *                                     "Allowed AI Keys" checkbox row up
 *                                     front, so it fetches even when the
 *                                     dialog is closed)
 *
 * Every handler short-circuits on `resourceType === 'document'` so the
 * top-level `page.goto('/workspaces')` still lands on Vite's SPA shell
 * instead of a JSON blob.
 */
async function routeWorkspacesListEndpoints(
  page: Page,
  opts: MockedListOpts = {},
): Promise<void> {
  const extra = opts.extraWorkspaces ?? [];
  // Row A — the "has a badge" workspace. Row B — a plain workspace to
  // prove only rows with non-zero counts render the badge.
  const workspaces = [
    {
      id: "1",
      name: "Primary Workspace",
      description: null,
      path: "/tmp/primary",
      allowed_key_ids: [1],
      gitignore_flockctl: false,
      gitignore_todo: false,
      gitignore_agents_md: false,
      created_at: T_CREATED,
      updated_at: T_CREATED,
    },
    {
      id: "2",
      name: "Secondary Workspace",
      description: null,
      path: "/tmp/secondary",
      allowed_key_ids: [1],
      gitignore_flockctl: false,
      gitignore_todo: false,
      gitignore_agents_md: false,
      created_at: T_CREATED,
      updated_at: T_CREATED,
    },
    ...extra.map((w) => ({
      id: w.id,
      name: w.name,
      description: null,
      path: w.path,
      allowed_key_ids: [1],
      gitignore_flockctl: false,
      gitignore_todo: false,
      gitignore_agents_md: false,
      created_at: T_CREATED,
      updated_at: T_CREATED,
    })),
  ];

  // One project per workspace — the attention-count reducer maps
  // attention items by their project_id to the owning workspace_id. The
  // id strings here are picked so `proj-<n>` belongs to workspace `<n>`.
  const projects = workspaces.map((w) => ({
    id: `proj-${w.id}`,
    name: `Project for ${w.name}`,
    path: w.path,
    workspace_id: w.id,
    default_model: null,
    default_agent: null,
    default_timeout: null,
    repo_url: null,
    permission_mode: null,
    created_at: T_CREATED,
    updated_at: T_CREATED,
  }));

  // Fan out the attention counts: for workspace id "X" with count N we
  // emit N task_approval rows pointing at project `proj-X`. The client
  // reducer (`attentionByWorkspace` in ui/src/pages/workspaces.tsx) walks
  // item.project_id → projectToWorkspace → workspace id to get the total.
  const attentionItems: Array<Record<string, unknown>> = [];
  for (const [wsId, count] of Object.entries(opts.attentionByWorkspace ?? {})) {
    for (let i = 0; i < count; i++) {
      attentionItems.push({
        kind: "task_approval",
        task_id: `${wsId}-${i + 1}`,
        project_id: `proj-${wsId}`,
        title: `Awaiting approval #${i + 1}`,
        since: T_CREATED,
      });
    }
  }

  const jsonBody = (obj: unknown) => JSON.stringify(obj);

  async function handleWorkspaces(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({
        items: workspaces,
        total: workspaces.length,
        offset: 0,
        limit: workspaces.length,
      }),
    });
  }

  async function handleProjects(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({
        items: projects,
        total: projects.length,
        offset: 0,
        limit: projects.length,
      }),
    });
  }

  async function handleAttention(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items: attentionItems, total: attentionItems.length }),
    });
  }

  async function handleKeys(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    // Two active keys so the "Allowed AI Keys" checkbox row renders
    // realistic content inside the Create-dialog scroll snapshot.
    const items = [
      {
        id: 1,
        label: "Claude Code",
        name: "Claude Code",
        provider: "anthropic",
        provider_type: "cli",
        is_active: true,
        created_at: T_CREATED,
        updated_at: T_CREATED,
      },
      {
        id: 2,
        label: "Anthropic API",
        name: "Anthropic API",
        provider: "anthropic",
        provider_type: "api",
        is_active: true,
        created_at: T_CREATED,
        updated_at: T_CREATED,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items, total: items.length }),
    });
  }

  await page.route(/\/workspaces(\?[^/]*)?$/, handleWorkspaces);
  await page.route(/\/projects(\?[^/]*)?$/, handleProjects);
  await page.route(/\/attention(\?[^/]*)?$/, handleAttention);
  await page.route(/\/keys(\?[^/]*)?$/, handleKeys);
}

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

test("workspace-create Browse button opens the directory picker and fills the path input", async ({
  page,
}) => {
  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();

  // Open the Create Workspace dialog.
  await page.getByRole("button", { name: "Create Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Create Workspace" })).toBeVisible();

  // Local Directory is the default source mode — the path input should be
  // present alongside the Browse… button.
  const pathInput = page.locator("#cw-path");
  await expect(pathInput).toBeVisible();
  await expect(pathInput).toHaveValue("");

  // Hit Browse… → the directory picker opens with a home breadcrumb.
  await page.getByTestId("cw-path-browse").click();
  await expect(page.getByRole("heading", { name: "Select a directory" })).toBeVisible();
  await expect(page.getByTestId("directory-picker-breadcrumb")).toBeVisible();

  // Select the default (resolved $HOME) directory. The picker writes the
  // absolute path back into the same path-input state.
  await page.getByRole("button", { name: "Select" }).click();
  await expect(page.getByRole("heading", { name: "Select a directory" })).toBeHidden();

  // Picker closed and the input now carries an absolute path.
  const filled = await pathInput.inputValue();
  expect(filled).not.toBe("");
  expect(filled.startsWith("/")).toBe(true);

  // And the same picker-shared localStorage key was updated — workspaces and
  // projects share "last picked" memory.
  const stored = await page.evaluate(() =>
    window.localStorage.getItem("flockctl.lastPickedPath"),
  );
  expect(stored).toBe(filled);
});

/**
 * List-page parity baselines.
 *
 * Two pixel-stable snapshots the list view has to honour:
 *
 *   1. Row with a "N waiting" badge — every row that owns attention items
 *      through its projects renders a destructive-tone Badge after the
 *      name. A regression that drops the attentionByWorkspace reducer (or
 *      the Badge itself) must fail this test.
 *
 *   2. Create-dialog scrolled — at 1280×600 (the tightest viewport the
 *      design was signed off against) the Create Workspace form does NOT
 *      fit and must scroll within its DialogContent (`max-h-[85vh]` +
 *      `overflow-y-auto`). The baseline captures the dialog mid-scroll
 *      so a layout change that accidentally drops the scroll container
 *      (e.g. swapping the wrapper to `overflow-hidden`) is caught.
 *
 * Both cases seed the list endpoints via `page.route` rather than the
 * API — the audit at ui/src/pages/workspaces.tsx:368 shows
 * `attention_count` is NOT a field on the workspaces response, so there
 * is no "seed via the API" path for case 1. Running the same mocks for
 * case 2 keeps the Create-dialog render deterministic (Active AI Keys
 * checkbox row, workspace list behind the dialog).
 *
 * Regenerate baselines with:
 *   npm run e2e:update -- ui/e2e/workspaces.spec.ts
 */
test.describe("workspaces list page (baseline protection)", () => {
  test("row with attention renders a 3-waiting badge", async ({ page }) => {
    // Primary Workspace owns 3 attention items via proj-1; Secondary
    // owns none and must render WITHOUT a badge. The snapshot covers
    // both rows so a future regression that puts the badge on the wrong
    // row (or every row) is visible in the diff.
    //
    // Freeze `Date.now()` so the timeAgo() cell renders "5m ago" on
    // every run — the "Xm ago" string is computed client-side from
    // (Date.now() - created_at) and would otherwise drift the pixel
    // baseline by one minute-bucket per minute of wall-clock elapsed.
    await page.clock.install({ time: new Date(T_NOW) });
    await routeWorkspacesListEndpoints(page, {
      attentionByWorkspace: { "1": 3 },
    });

    await page.goto("/workspaces");
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();

    // DOM contract before the pixels: the badge must be bound to the
    // row with 3 pending items and announced via aria-label so screen
    // readers pick it up. The Secondary row must NOT carry a badge.
    const primaryRow = page.getByRole("row", { name: /Primary Workspace/ });
    const secondaryRow = page.getByRole("row", { name: /Secondary Workspace/ });
    const badge = primaryRow.getByLabel("3 items waiting on you");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("3 waiting");
    await expect(
      secondaryRow.getByLabel(/items? waiting on you/),
    ).toHaveCount(0);

    await freeze(page);
    // Crop to just the row so the snapshot doesn't depend on the sidebar
    // badge / header layout — this file's concern is row parity only.
    await expect(primaryRow).toHaveScreenshot(
      "workspaces-list-row-with-waiting-badge.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("create-dialog scrolls inside a 1280×600 viewport", async ({ page }) => {
    // 1280×600 is the tightest viewport the design was signed off
    // against — at this height the DialogContent's `max-h-[85vh]`
    // (~510px) cannot fit Name + Description + Source toggle + Path +
    // Allowed Keys + Gitignore toggles + Footer without an inner
    // scroll container. The baseline guards against a refactor that
    // accidentally removes `overflow-y-auto` (the form would then clip
    // the Gitignore toggles and the Create button off the bottom).
    await page.setViewportSize({ width: 1280, height: 600 });
    // Same clock-freeze as the badge case — the dialog sits on top of
    // the list view which renders the time-ago cells behind it.
    await page.clock.install({ time: new Date(T_NOW) });
    await routeWorkspacesListEndpoints(page, {
      attentionByWorkspace: { "1": 3 },
    });

    await page.goto("/workspaces");
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();

    await page.getByRole("button", { name: "Create Workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Workspace" }),
    ).toBeVisible();

    // The scroll container is the inner `<div class="flex-1 ...
    // overflow-y-auto">` inside the <form>. Grab it by its overflow
    // style (the class is the only stable-ish selector — no testid
    // exists today) and assert that content genuinely overflows it.
    const scroller = page
      .locator("role=dialog")
      .locator("div.overflow-y-auto")
      .first();
    await expect(scroller).toBeVisible();
    const { clientH, scrollH } = await scroller.evaluate((el) => ({
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    }));
    expect(scrollH).toBeGreaterThan(clientH);

    // Scroll halfway down so the baseline captures the dialog
    // mid-scroll — both the top (Name field clipped) and the bottom
    // (Gitignore toggles / Create button below the fold) are visible
    // in the diff if a future change drops the scroll affordance.
    await scroller.evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    });

    await freeze(page);
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toHaveScreenshot(
      "workspaces-create-dialog-scrolled.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });
});

/**
 * Workspace-detail header Chat button — behavioural + visual parity.
 *
 * The header Chat button mirrors the Projects page: if the workspace
 * already has any chats it jumps to the most recent one (ordered by
 * `updated_at` on the client); otherwise it creates a fresh
 * workspace-scoped chat and routes into it. Three cases, grouped:
 *
 *   1. "no chats" — click creates a chat and navigates to /chats/:id
 *   2. "has chat" — click routes straight to the seeded chat id, no
 *                   POST /chats fires
 *   3. visual     — full-width header baseline so a reviewer can
 *                   eyeball it against the Projects-detail header
 *
 * Cases 1 & 2 hit the real e2e backend (the same daemon the fixtures
 * use for every other non-visual spec) — the header renders identically
 * with or without mocks, and letting the real backend persist the chat
 * row exercises the same `POST /chats` + `GET /chats?workspace_id=…`
 * round-trip the UI ships in production. Case 3 locks to mocks because
 * the `Created Xm ago` line in the header is wall-clock-dependent and
 * would otherwise drift the pixels every minute.
 *
 * Regenerate the visual baseline with:
 *   cd ui && npm run e2e:update -- workspaces.spec.ts
 */
test.describe("workspace-detail header Chat button", () => {
  test("creates a new chat and navigates when the workspace has none", async ({
    page,
    request,
  }) => {
    const ws = await createWorkspace(request, uniq("ws-chat-new"));

    await page.goto(`/workspaces/${ws.id}`);
    await expect(page.getByRole("heading", { name: ws.name }).first()).toBeVisible({
      timeout: 10_000,
    });

    // The button stays disabled until `useWorkspace` resolves — wait for
    // the enabled state before clicking so the click isn't swallowed.
    const chatBtn = page.getByTestId("workspace-detail-page-chat");
    await expect(chatBtn).toBeEnabled();
    await expect(chatBtn).toHaveText(/Chat/);

    await chatBtn.click();

    // Chat button fires `useCreateChat` then navigates to `/chats/:id` —
    // wait for the URL to settle on a real numeric chat id.
    await page.waitForURL(/\/chats\/\d+$/, { timeout: 10_000 });

    // Verify the chat backing the new URL is owned by this workspace —
    // catches a regression where the button accidentally forgets to
    // forward `workspaceId` and creates an unscoped chat instead. The
    // backend's raw `GET /chats/:id` payload is snake_case (the UI's
    // `apiFetch` wrapper is what camel-cases on ingress); asserting on
    // the raw `workspace_id` field matches the wire shape directly.
    const chatId = page.url().split("/chats/")[1];
    const detail = await request.get(`/chats/${chatId}`);
    expect(detail.status()).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    // Accept either snake or camel, and both string + number for the id —
    // every other `id` in the backend is serialized as a string, but
    // `workspace_id` historically drifted between types across migrations.
    const wsId = body.workspace_id ?? body.workspaceId;
    expect(wsId === ws.id || wsId === String(ws.id)).toBe(true);
  });

  test("navigates to the existing chat when the workspace already has one", async ({
    page,
    request,
  }) => {
    const ws = await createWorkspace(request, uniq("ws-chat-seeded"));

    // Seed a workspace-scoped chat up front — the hook `useChats` filters
    // by workspaceId, so the Chat button's "jump to most recent" branch
    // will pick this row (it's the only one) instead of minting a new
    // chat. We assert on the chat id below; the title is incidental.
    const seedRes = await request.post("/chats", {
      data: { workspaceId: ws.id, title: uniq("seeded-chat") },
    });
    expect([200, 201]).toContain(seedRes.status());
    const seededChat = (await seedRes.json()) as { id: string };

    await page.goto(`/workspaces/${ws.id}`);
    await expect(page.getByRole("heading", { name: ws.name }).first()).toBeVisible({
      timeout: 10_000,
    });

    const chatBtn = page.getByTestId("workspace-detail-page-chat");
    await expect(chatBtn).toBeEnabled();
    await chatBtn.click();

    // Strict match — must be the exact seeded chat id, NOT a freshly
    // created one. The UI sorts by `updated_at` DESC on the client
    // before routing, so with a single seeded chat this is unambiguous.
    await expect(page).toHaveURL(new RegExp(`/chats/${seededChat.id}$`), {
      timeout: 10_000,
    });
  });

  test("header Chat button visual baseline — mirrors the Projects header", async ({
    page,
  }) => {
    // Locked to mocks: the `Created Xm ago` line below the title is
    // derived from `Date.now() - workspace.created_at` and would drift
    // the baseline by a minute-bucket per minute of wall-clock drift on
    // the e2e runner. Freezing the clock plus fixed fixture timestamps
    // pins the string to "5m ago" on every run.
    await page.clock.install({ time: new Date(T_NOW) });
    await routeWorkspaceDetailEndpoints(page, {
      workspaceId: "1",
      chats: [],
    });

    await page.goto("/workspaces/1");
    await expect(
      page.getByRole("heading", { name: "Primary Workspace" }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Button must be in its "idle" state — not the "Creating…" label —
    // otherwise the baseline would capture a transient in-flight render.
    const chatBtn = page.getByTestId("workspace-detail-page-chat");
    await expect(chatBtn).toBeEnabled();
    await expect(chatBtn).toHaveText(/^Chat$/);

    await freeze(page);

    // Crop to the entire page header (title + Created line + Chat/TODO
    // button cluster + KPI bar). The outer wrapper is the first child of
    // the page root — named via the shared `workspace-detail-page`
    // testid. Full-width so a reviewer can diff the Chat button's
    // alignment, spacing, and tone against the Projects-detail header
    // by eye.
    const header = page
      .locator('[data-testid="workspace-detail-page"] > div')
      .first();
    await expect(header).toBeVisible();
    await expect(header).toHaveScreenshot(
      "workspace-detail-header-chat-button-matches-project.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });
});

/**
 * Workspace-detail **Config tab** behavioural coverage.
 *
 * Three behavioural cases exercising flows that only surface through the
 * rendered UI (the component-level contract is locked by the vitest
 * tests under `ui/src/pages/workspace-detail-components/__tests__/`):
 *
 *   1. Happy-path save — edit the Description, click Save, confirm the
 *      "Saved" badge renders and the mutation reaches the wire. Proves
 *      the two-mutation fan-out (`updateWorkspace` +
 *      `updateWorkspaceConfig`) isn't silently swallowed by the tab.
 *   2. Failure surface — `page.route` stubs a 500 on the PATCH for the
 *      workspace; the click must flip the inline error paragraph
 *      (`data-testid="workspace-config-error"`) to the server's error
 *      message rather than silently no-op'ing.
 *   3. Danger-Zone delete — open the ConfirmDialog, confirm, and assert
 *      the page navigates back to `/workspaces` with the workspace
 *      removed from the list and the backend returning 404 for its id.
 *
 * Plus two pixel baselines for the tab composition:
 *
 *   • `workspace-detail-config-tab-full.png` — the entire
 *     `[data-testid="workspace-config-tab"]` container. Waits for every
 *     card / panel heading so the screenshot captures a settled state.
 *   • `workspace-detail-config-tab-danger-zone.png` — just the Danger
 *     Zone card (`[data-testid="workspace-config-danger-zone"]`) so a
 *     regression that drops the destructive border / Delete button is
 *     pinned down precisely regardless of where the card ends up.
 *
 * Selectors are deliberately role-based / testid-based; no class-name
 * coupling. Baselines regenerate via:
 *   cd ui && npm run e2e:update -- workspaces.spec.ts
 */
test.describe("workspace-detail config tab", () => {
  test("saving a description edit surfaces the Saved badge", async ({
    page,
    request,
  }) => {
    const name = uniq("ws-config-save");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}`);
    await expect(page.getByTestId("workspace-detail-page")).toBeVisible({
      timeout: 15_000,
    });

    // Role-based activation — the tab trigger carries accessible name
    // "Config" via its text content, per the Radix Tabs contract.
    await page.getByRole("tab", { name: /^config$/i }).click();
    await expect(page).toHaveURL(/[?&]tab=config(&|$)/);
    await expect(page.getByTestId("workspace-config-tab")).toBeVisible();

    // Editing the Description leaves the Name field intact so the save
    // flow still satisfies the non-empty-name invariant and the
    // non-empty allow-list invariant (seeded by `createWorkspace`).
    const description = page.getByRole("textbox", { name: /description/i });
    await description.fill("Edited via e2e Config tab");

    await page.getByTestId("workspace-config-save").click();

    // "Saved" badge renders for ~3s on success. Scope to the tab
    // container so the literal word "Saved" doesn't match elsewhere.
    await expect(
      page
        .getByTestId("workspace-config-tab")
        .getByText("Saved", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });

    // Round-trip via the API — the persisted description confirms the
    // mutation hit the server, not just the client-side badge.
    const refetched = await request.get(`/workspaces/${ws.id}`);
    expect(refetched.status()).toBe(200);
    const body = (await refetched.json()) as { description: string | null };
    expect(body.description).toBe("Edited via e2e Config tab");
  });

  test("surfaces an inline error when PATCH /workspaces returns 500", async ({
    page,
    request,
  }) => {
    const name = uniq("ws-config-save-fail");
    const ws = await createWorkspace(request, name);

    // Stub the PATCH *before* navigation so the click never races the
    // route wiring. GETs pass through via `route.fallback()` so the
    // page hydrates normally off the real backend.
    await page.route(`**/workspaces/${ws.id}`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "server melted (stubbed)" }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`/workspaces/${ws.id}?tab=config`);
    await expect(page.getByTestId("workspace-config-tab")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tab", { name: /^config$/i })).toHaveAttribute(
      "data-state",
      "active",
    );

    await page.getByTestId("workspace-config-save").click();

    // Inline error paragraph mirrors Error.message from `apiFetch` —
    // assertion is loose enough to tolerate either the literal server
    // payload or the client's fallback "Failed to save" copy.
    const err = page.getByTestId("workspace-config-error");
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText(
      /server melted \(stubbed\)|Failed to save/i,
    );
    // And no "Saved" badge must slip through on the failure path.
    await expect(
      page
        .getByTestId("workspace-config-tab")
        .getByText("Saved", { exact: true }),
    ).toHaveCount(0);
  });

  test("danger zone delete confirms and returns to /workspaces", async ({
    page,
    request,
  }) => {
    const name = uniq("ws-config-delete");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}?tab=config`);
    await expect(page.getByTestId("workspace-config-tab")).toBeVisible({
      timeout: 15_000,
    });

    // Kick off the Danger-Zone flow from the testid'd button — the
    // visible "Delete Workspace" button in the card opens the confirm
    // dialog, which itself mounts a "Delete" button inside `role=dialog`.
    await page.getByTestId("workspace-config-delete").click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Delete Workspace" }),
    ).toBeVisible();
    // Scope the confirm click to `role=dialog` so the outer "Delete
    // Workspace" button in the Danger Zone card doesn't match.
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Navigated back to the list page; the deleted workspace is gone.
    await expect(page).toHaveURL(/\/workspaces$/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Workspaces" }),
    ).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0, { timeout: 10_000 });

    // Belt-and-braces: backend must 404 on the deleted id.
    const gone = await request.get(`/workspaces/${ws.id}`);
    expect(gone.status()).toBe(404);
  });

  test("config tab matches the full baseline", async ({ page, request }) => {
    const name = uniq("ws-config-full");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}?tab=config`);
    // Wait for every card title before snapshotting — each panel
    // (Skills / MCP / Secrets / AGENTS.md) hydrates asynchronously and
    // the Config tab body spans the full viewport height, so a
    // premature shot would catch mid-render skeletons. `CardTitle` in
    // the shadcn wrapper is a `<div data-slot="card-title">` (not a
    // heading), so we match the title text inside that slot rather
    // than using `getByRole('heading')`.
    const tab = page.getByTestId("workspace-config-tab");
    await expect(tab).toBeVisible({ timeout: 15_000 });
    for (const title of [
      "General",
      "AI Configuration",
      "Gitignore",
      "Skills",
      "MCP Servers",
      "Secrets",
      "Danger Zone",
    ]) {
      await expect(
        tab
          .locator('[data-slot="card-title"]')
          .filter({ hasText: new RegExp(`^${title}$`) }),
      ).toBeVisible({ timeout: 15_000 });
    }

    await freeze(page);
    await expect(tab).toHaveScreenshot(
      "workspace-detail-config-tab-full.png",
      { maxDiffPixelRatio: 0.03 },
    );
  });

  test("danger zone card matches its baseline", async ({ page, request }) => {
    const name = uniq("ws-config-dz");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}?tab=config`);
    await expect(page.getByTestId("workspace-config-tab")).toBeVisible({
      timeout: 15_000,
    });

    const dzCard = page.getByTestId("workspace-config-danger-zone");
    await expect(dzCard).toBeVisible();
    // Scroll into view so Playwright captures the card rendered with
    // its destructive border + Delete button in frame (otherwise the
    // header can clip off the top edge of the element screenshot).
    await dzCard.scrollIntoViewIfNeeded();

    await freeze(page);
    await expect(dzCard).toHaveScreenshot(
      "workspace-detail-config-tab-danger-zone.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });
});
