import type { Page } from "@playwright/test";

/**
 * Fixtures for the /tasks page e2e specs.
 *
 * The Tasks page renders against three read endpoints:
 *
 *   - GET /tasks?offset=...      — useTasks (table + kanban views)
 *   - GET /tasks/stats           — useTaskStats (KPI cards at the top)
 *   - GET /projects              — useProjects (project labels in kanban view)
 *
 * and two write endpoints we keep mocked for backwards compatibility with
 * older snapshots that still exercise approve/reject:
 *
 *   - POST /tasks/:id/approve
 *   - POST /tasks/:id/reject
 *
 * Rather than seeding hundreds of rows through the real backend (slow, and
 * the auto-executor keeps mutating the state out from under us), every spec
 * routes the endpoints at the browser level via `page.route`. That gives us
 * a byte-deterministic fixture — 500 done tasks for the pagination edge,
 * one running task and one pending_approval task for kanban swim-lanes —
 * which is exactly what the baselines need.
 *
 * The shape returned here is already in snake_case (the wire format the
 * client's `apiFetch` normalises *to*), so it round-trips through the
 * key-conversion layer unchanged.
 */

/** Sentinel project used by every mocked task. */
export const MOCK_PROJECT_ID = "proj-mock";
export const MOCK_PROJECT_NAME = "Mock Project";

export const RUNNING_TASK_ID = "running-1";
export const PENDING_APPROVAL_TASK_ID = "pending-1";
export const FIRST_DONE_TASK_ID = "done-1";

/** Total count of mocked tasks — 500 done + 1 running + 1 pending_approval. */
export const TOTAL_MOCK_TASKS = 502;

export interface MockTask {
  id: string;
  status: string;
  prompt: string | null;
  prompt_file: string | null;
  agent: string | null;
  model: string | null;
  /** Most recent model from `usage_records` for this task (or null). */
  actual_model_used: string | null;
  timeout_seconds: number;
  project_id: string | null;
  assigned_key_id: number | null;
  assigned_key_label: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  working_dir: string | null;
  created_at: string;
  updated_at: string;
  git_commit_before: string | null;
  git_commit_after: string | null;
  git_diff_summary: string | null;
  requires_approval: boolean;
  approval_status: string | null;
  approved_at: string | null;
  approval_note: string | null;
  permission_mode: string | null;
  parent_task_id: string | null;
}

/** Fixed timestamps — keeps screenshot pixels stable across runs. */
const T_CREATED = "2026-04-23T10:00:00.000Z";
const T_STARTED = "2026-04-23T10:00:00.000Z";
const T_COMPLETED = "2026-04-23T10:00:30.000Z";

function buildDoneTask(i: number): MockTask {
  return {
    id: `done-${i}`,
    status: "done",
    prompt: `done task ${i} prompt`,
    prompt_file: null,
    agent: "claude-code",
    model: "claude-sonnet-4",
    actual_model_used: "claude-sonnet-4",
    timeout_seconds: 300,
    project_id: MOCK_PROJECT_ID,
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: 0,
    started_at: T_STARTED,
    completed_at: T_COMPLETED,
    working_dir: "/tmp/mock",
    created_at: T_CREATED,
    updated_at: T_COMPLETED,
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: null,
    parent_task_id: null,
  };
}

function buildRunningTask(): MockTask {
  return {
    ...buildDoneTask(0),
    id: RUNNING_TASK_ID,
    status: "running",
    prompt: "Running headline — streams into the live rail",
    completed_at: null,
    exit_code: null,
  };
}

function buildPendingApprovalTask(): MockTask {
  return {
    ...buildDoneTask(0),
    id: PENDING_APPROVAL_TASK_ID,
    status: "pending_approval",
    prompt: "Waiting for reviewer approval",
    completed_at: null,
    exit_code: null,
    requires_approval: true,
    approval_status: null,
  };
}

/**
 * Build the full 502-task fixture.
 *
 * Ordering matters for the kanban: the running + pending_approval rows
 * show up first so the relevant swim-lanes are populated, then the 500
 * done tasks trail behind. The backend `/tasks` route orders by
 * `created_at DESC` in reality; mimicking that here keeps the visual
 * baseline closer to prod.
 */
export function buildMockTasks(): MockTask[] {
  const out: MockTask[] = [];
  out.push(buildRunningTask());
  out.push(buildPendingApprovalTask());
  for (let i = 1; i <= 500; i++) {
    out.push(buildDoneTask(i));
  }
  return out;
}

/** Byte-deterministic stats payload matching `TaskStats`. */
export function buildMockStats() {
  return {
    total: TOTAL_MOCK_TASKS,
    queued: 0,
    assigned: 0,
    running: 1,
    completed: 500,
    done: 500,
    failed: 0,
    timed_out: 0,
    cancelled: 0,
    avg_duration_seconds: 30,
  };
}

/** Minimal project list — Kanban view looks up names via `useProjects`. */
export function buildMockProjects() {
  return [
    {
      id: MOCK_PROJECT_ID,
      name: MOCK_PROJECT_NAME,
      path: "/tmp/mock",
      workspace_id: null,
      default_model: null,
      default_agent: null,
      default_timeout: null,
      repo_url: null,
      permission_mode: null,
      created_at: T_CREATED,
      updated_at: T_CREATED,
    },
  ];
}

export interface RouteTasksOpts {
  tasks?: MockTask[];
  /** Force `/tasks/:id/approve` to fail with the given status + error. */
  approveStatus?: number;
  approveError?: string;
  /** Collect (method, url) tuples of every approve/reject call. */
  approveRequests?: Array<{ url: string; method: string; body: string | null }>;
}

/**
 * Install all the /tasks page route mocks on `page`.
 *
 * Called from the spec's `test.beforeEach`. Every handler returns its
 * mock payload directly — no fallthrough to the real backend — so the
 * tests stay deterministic and don't depend on the auto-executor's
 * scheduler ticks.
 */
export async function routeTasksEndpoints(
  page: Page,
  opts: RouteTasksOpts = {},
): Promise<void> {
  const tasks = opts.tasks ?? buildMockTasks();

  // GET /tasks (list) — respects `offset` / `limit` params. The table view
  // pages at 20; the kanban view loads 200 in one shot. Returning the
  // slice the client asked for lets both views exercise the real code path.
  //
  // Resource-type guard: `page.route` also fires for the top-level SPA
  // document load (Playwright surfaces every request through the router,
  // including navigations). We MUST let the document request fall through
  // to Vite so it serves `index.html`, otherwise `page.goto('/tasks')`
  // lands on a JSON blob instead of the app.
  await page.route(/\/tasks(\?[^/]*)?$/, async (route) => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    const url = new URL(req.url());
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const status = url.searchParams.get("status");
    const projectId = url.searchParams.get("project_id");
    const agent = url.searchParams.get("agent");

    let filtered = tasks;
    if (status) filtered = filtered.filter((t) => t.status === status);
    if (projectId) filtered = filtered.filter((t) => t.project_id === projectId);
    if (agent) filtered = filtered.filter((t) => t.agent === agent);

    const slice = filtered.slice(offset, offset + limit);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: slice,
        total: filtered.length,
        offset,
        limit,
      }),
    });
  });

  // GET /tasks/stats — KPI cards at the top of the page.
  await page.route(/\/tasks\/stats(\?|$)/, async (route) => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildMockStats()),
    });
  });

  // GET /projects — Kanban view hydrates project-name labels from here.
  // The client `fetchProjects` expects a `PaginatedResponse<Project>`
  // shape (`{ items, total, offset, limit }`) and pulls `.items` out of
  // it; returning a bare array would trip React Query's
  // "Query data cannot be undefined" guard downstream.
  await page.route(/\/projects(\?|$)/, async (route) => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    const items = buildMockProjects();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: items.length,
        offset: 0,
        limit: items.length,
      }),
    });
  });

  // POST /tasks/:id/approve  and  POST /tasks/:id/reject.
  //
  // Kept mocked even after the cards view was retired: future inline-action
  // surfaces (or the task-detail page) still hit these endpoints, and we
  // want any spec that exercises them to fail fast on a routing change
  // rather than silently fall through to the real backend.
  await page.route(/\/tasks\/[^/]+\/(approve|reject)$/, async (route) => {
    const req = route.request();
    if (opts.approveRequests) {
      opts.approveRequests.push({
        url: req.url(),
        method: req.method(),
        body: req.postData(),
      });
    }
    if (opts.approveStatus && opts.approveStatus >= 400) {
      await route.fulfill({
        status: opts.approveStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: opts.approveError ?? `HTTP ${opts.approveStatus}`,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}
