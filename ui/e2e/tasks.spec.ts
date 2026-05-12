import { test, expect, type Page } from "@playwright/test";
import { createProject, createTask, uniq } from "./_helpers";

/**
 * E2E coverage for the `/tasks` page (slice 24-00 T05).
 *
 * Two halves:
 *
 *   1. Behavioural — pre-existing assertions (list shows API-created
 *      task, GET /tasks fires on load, navigation to detail). These
 *      guard against regressions in the data layer when the page
 *      assembly changes.
 *
 *   2. Visual baselines (slice T05) — default + filter applied +
 *      bulk-selected + empty × light/dark. Baselines live under
 *      e2e/__screenshots__/tasks.spec.ts/ per the
 *      `snapshotPathTemplate` in playwright.config.ts.
 *
 * The visual specs intercept `/tasks`, `/projects`, `/tasks/stats`, and
 * `/attention` so the baseline does not drift as the e2e backend
 * accumulates rows across reruns. Theme is pinned via
 * `flockctl-theme` localStorage before navigation so the dark baseline
 * doesn't fight the OS preference of the testing host.
 */

// ---------------------------------------------------------------------------
// Behavioural tests (kept stable through the M24 redesign).
// ---------------------------------------------------------------------------

test("tasks page renders list after a task is created", async ({ page, request }) => {
  const proj = await createProject(request, uniq("tasks-list"));
  const task = await createTask(request, proj.id);

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
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

// ---------------------------------------------------------------------------
// Visual baselines (slice 24-00 T05).
//
// Default (cards-style flat table) × light/dark, filter-applied (?status=failed)
// × light, bulk-selected × light, and the initial empty-state × light/dark.
// Each variant snapshots the page after rendering against a fixed seeded
// payload so the baseline is reproducible across machines and reruns.
// ---------------------------------------------------------------------------

async function freezeAnimations(page: Page) {
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

async function pinTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

const FIXTURE_NOW = "2025-01-01T00:00:00.000Z";

interface TaskFixture {
  id: string;
  status: string;
  prompt: string;
  project_id: string | null;
  created_at: string;
  completed_at: string | null;
  cost_usd: number;
}

const FIXTURE_TASKS: TaskFixture[] = [
  {
    id: "task-aaaaaaaa-1111-2222-3333-444444444444",
    status: "running",
    prompt: "Refactor authentication flow",
    project_id: "p-alpha",
    created_at: "2025-01-01T00:00:00.000Z",
    completed_at: null,
    cost_usd: 0.04,
  },
  {
    id: "task-bbbbbbbb-1111-2222-3333-444444444444",
    status: "queued",
    prompt: "Migrate user schema",
    project_id: "p-beta",
    created_at: "2025-01-01T00:01:00.000Z",
    completed_at: null,
    cost_usd: 0,
  },
  {
    id: "task-cccccccc-1111-2222-3333-444444444444",
    status: "done",
    prompt: "Add CI workflow",
    project_id: "p-alpha",
    created_at: "2025-01-01T00:02:00.000Z",
    completed_at: "2025-01-01T00:08:30.000Z",
    cost_usd: 0.12,
  },
  {
    id: "task-dddddddd-1111-2222-3333-444444444444",
    status: "failed",
    prompt: "Bump dependencies",
    project_id: "p-beta",
    created_at: "2025-01-01T00:03:00.000Z",
    completed_at: "2025-01-01T00:04:00.000Z",
    cost_usd: 0.02,
  },
];

const FIXTURE_PROJECTS = [
  { id: "p-alpha", name: "Alpha" },
  { id: "p-beta", name: "Beta" },
];

function buildTaskPayload(fixture: TaskFixture) {
  return {
    id: fixture.id,
    status: fixture.status,
    prompt: fixture.prompt,
    prompt_file: null,
    agent: "claude",
    model: null,
    actual_model_used: null,
    timeout_seconds: 300,
    project_id: fixture.project_id,
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: null,
    started_at: fixture.created_at,
    completed_at: fixture.completed_at,
    working_dir: null,
    created_at: fixture.created_at,
    updated_at: fixture.created_at,
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: null,
    parent_task_id: null,
    liveMetrics: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_cost_usd: fixture.cost_usd,
      turns: 0,
      duration_ms: 0,
    },
  };
}

function buildProjectPayload(p: { id: string; name: string }) {
  return {
    id: p.id,
    name: p.name,
    description: null,
    path: `/tmp/${p.name.toLowerCase()}`,
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  };
}

interface StubOptions {
  tasks?: TaskFixture[];
  projects?: Array<{ id: string; name: string }>;
}

async function stubTasksList(page: Page, opts: StubOptions = {}) {
  const tasks = opts.tasks ?? FIXTURE_TASKS;
  const projects = opts.projects ?? FIXTURE_PROJECTS;
  const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
  const apiOrigin = `http://127.0.0.1:${backendPort}`;

  const respond = async (
    route: import("@playwright/test").Route,
    payload: unknown,
  ) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  };

  // Tasks list — apply server-side ?status= so the filtered baseline
  // produces a coherent narrowed rowset rather than dumping the full
  // fixture for every URL.
  const respondTasks = async (route: import("@playwright/test").Route) => {
    const url = new URL(route.request().url());
    const statusParam = url.searchParams.get("status");
    let rows = tasks;
    if (statusParam) {
      rows = rows.filter((t) => t.status === statusParam);
    }
    const payload = {
      items: rows.map(buildTaskPayload),
      total: rows.length,
    };
    await respond(route, payload);
  };

  await page.route(`${apiOrigin}/tasks`, async (route) => {
    if (route.request().method() === "GET") return respondTasks(route);
    await route.fallback();
  });
  await page.route(`${apiOrigin}/tasks?**`, async (route) => {
    if (route.request().method() === "GET") return respondTasks(route);
    await route.fallback();
  });

  // Stats — used by SectionHeader subtitle.
  const stats = {
    total: tasks.length,
    queued: tasks.filter((t) => t.status === "queued").length,
    assigned: 0,
    running: tasks.filter((t) => t.status === "running").length,
    completed: 0,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    timed_out: 0,
    cancelled: 0,
    failed_rerun: 0,
    failed_not_rerun: tasks.filter((t) => t.status === "failed").length,
    superseded_failures: 0,
    build_after_rerun: 0,
    avg_duration_seconds: null,
  };
  await page.route(`${apiOrigin}/tasks/stats`, async (route) => {
    await respond(route, stats);
  });
  await page.route(`${apiOrigin}/tasks/stats?**`, async (route) => {
    await respond(route, stats);
  });

  // Projects — for the filter dropdown.
  await page.route(`${apiOrigin}/projects`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: projects.map(buildProjectPayload),
        total: projects.length,
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/projects?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: projects.map(buildProjectPayload),
        total: projects.length,
      });
      return;
    }
    await route.fallback();
  });

  // Quiet shell-bar badges so the screenshot doesn't flicker on
  // whatever is in the seeded backend.
  await page.route(`${apiOrigin}/attention*`, async (route) => {
    await respond(route, { items: [] });
  });
}

async function waitForTasksPage(page: Page) {
  await expect(
    page.getByTestId("tasks-page").getByRole("heading", {
      name: "Tasks",
      level: 1,
    }),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("tasks page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`default — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await stubTasksList(page);
      await page.goto("/tasks");
      await waitForTasksPage(page);
      await expect(page.getByTestId("tasks-table")).toBeVisible({
        timeout: 10_000,
      });
      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`tasks-default-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`empty — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await stubTasksList(page, { tasks: [] });
      await page.goto("/tasks");
      await waitForTasksPage(page);
      await expect(page.getByTestId("tasks-empty-state")).toBeVisible({
        timeout: 10_000,
      });
      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`tasks-empty-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test("filter applied — ?status=failed (light)", async ({ page }) => {
    await pinTheme(page, "light");
    await stubTasksList(page);
    await page.goto("/tasks?status=failed");
    await waitForTasksPage(page);
    // Either the filtered table OR the filtered empty-state — both are
    // valid visual outcomes; assert the filter chip is engaged.
    await expect(
      page.getByTestId("tasks-status-toggle"),
    ).toBeVisible({ timeout: 10_000 });
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("tasks-filtered-failed.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("bulk-selected — first row checked (light)", async ({ page }) => {
    await pinTheme(page, "light");
    await stubTasksList(page);
    await page.goto("/tasks");
    await waitForTasksPage(page);
    await expect(page.getByTestId("tasks-table")).toBeVisible({
      timeout: 10_000,
    });
    // Click the first row checkbox to reveal the bulk toolbar.
    const firstCheckbox = page
      .getByTestId("tasks-table-row-checkbox")
      .first();
    await firstCheckbox.click();
    await expect(page.getByTestId("tasks-bulk-toolbar")).toBeVisible({
      timeout: 5_000,
    });
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("tasks-bulk-selected.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
