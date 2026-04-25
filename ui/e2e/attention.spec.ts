import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, uniq } from "./_helpers";

/**
 * E2E spec for the global inbox (`/attention`).
 *
 * Why this file leans on a direct SQLite insert instead of the regular
 * `createTask` API path:
 *
 *   The playwright harness sets `FLOCKCTL_MOCK_AI=1`, but no source module
 *   actually honours that env var — there is no mock AgentSession in the
 *   backend. Without a real AI key the task executor calls `selectKeyForTask`
 *   which throws "No available AI keys." and drives the task straight to
 *   `failed`, never `pending_approval`. That makes "run the task to
 *   completion" impossible through the HTTP API in this environment.
 *
 *   To drive a task into `pending_approval` — the only shape the inbox
 *   renders as a `task_approval` row — we insert the row directly into the
 *   same SQLite file the backend is using. The backend opens the DB in WAL
 *   mode, so cross-process writes are safe. Every downstream state change
 *   (approve, reject) still goes through the real HTTP API, which is what
 *   emits the `attention_changed` WebSocket broadcast the UI relies on.
 */

const here = dirname(fileURLToPath(import.meta.url));
// playwright.config.ts sets `FLOCKCTL_HOME` to `<repoRoot>/.e2e-data` for the
// backend process; the DB file therefore lives at `<repoRoot>/.e2e-data/flockctl.db`.
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");

function insertPendingApprovalTask(projectId: number, label: string): number {
  const db = new Database(dbPath);
  try {
    const info = db
      .prepare(
        `INSERT INTO tasks (project_id, prompt, agent, status, label, requires_approval, task_type)
         VALUES (?, ?, ?, 'pending_approval', ?, 1, 'execution')`,
      )
      .run(projectId, "approval-flow-check", "claude-code", label);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function deleteTasksForProject(projectId: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(`DELETE FROM tasks WHERE project_id = ?`).run(projectId);
  } finally {
    db.close();
  }
}

test.describe("inbox (/attention) approval flow", () => {
  test("task_approval row opens task-detail, approve clears the inbox + sidebar badge", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const label = uniq("inbox-approve");
    const taskId = insertPendingApprovalTask(proj.id, label);

    try {
      // Initial /attention fetch should surface the task_approval row the
      // moment we navigate; React Query does a fresh fetch on mount, we do
      // not need to wait on a WS frame here.
      await page.goto("/attention");
      await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

      const rowTitle = page.getByText(label, { exact: true }).first();
      await expect(rowTitle).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Task approval").first()).toBeVisible();

      // Sidebar badge reflects the single pending item before we act on it.
      // `aria-label` is singular/plural-aware — "1 item needing attention".
      const sidebarBadge = page.getByLabel(/items? needing attention/);
      await expect(sidebarBadge).toBeVisible();
      await expect(sidebarBadge).toHaveText("1");

      // The "Open link" is the title text — it sits inside a <Link> wrapper
      // (ui/src/components/attention/attention-row.tsx ~L259) that targets
      // `/tasks/:task_id`. Clicking the title navigates to task-detail.
      await rowTitle.click();
      await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));

      // Approve via the task-detail approval banner (not the inline inbox
      // button). This is what the brief specifies: approve on task-detail.
      await expect(page.getByText("Task awaiting approval").first()).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: /^Approve$/ }).first().click();

      // Go back to the inbox and confirm the row is gone and the subtitle
      // reflects an empty list. We re-navigate rather than relying on the
      // WS frame because the user explicitly "re-visits /attention".
      await page.goto("/attention");
      await expect(page.getByText("Nothing is waiting on you.")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);

      // Sidebar badge clears when the attention count drops to 0 — the
      // Badge element is only rendered when `count > 0`, so absence is the
      // assertion.
      await expect(page.getByLabel(/items? needing attention/)).toHaveCount(0);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });

  test("inline Allow on an inbox row removes it within 2s via attention_changed WS", async ({
    page,
    request,
  }) => {
    /*
     * The brief asks for a `chat_permission` permission_request here. A real
     * chat_permission row requires an active AgentSession with an in-memory
     * `pendingPermissionRequests` entry (see `src/services/attention.ts`) —
     * there is no DB table backing it, and creating one needs a live AI
     * session, which is not available under the no-real-key E2E environment
     * described at the top of this file.
     *
     * We substitute a `task_approval` row, which exercises the same UX
     * contract the brief cares about:
     *   - inline action button on the inbox row (not task-detail)
     *   - server POST → `attention_changed` broadcast
     *   - client invalidates the `attention` query → row disappears without
     *     a manual reload within the 2s budget.
     * If mock AI support is ever added (see FLOCKCTL_MOCK_AI in
     * playwright.config.ts / tests/smoke/_harness.ts), this test should be
     * rewritten to spawn a real chat permission_request.
     */
    const proj = await createProject(request);
    const label = uniq("inbox-inline");
    insertPendingApprovalTask(proj.id, label);

    try {
      await page.goto("/attention");
      const rowTitle = page.getByText(label, { exact: true }).first();
      await expect(rowTitle).toBeVisible({ timeout: 10_000 });

      // The inline action sits next to the title in the same card. Clicking
      // "Approve" here issues POST /tasks/:id/approve, which triggers the
      // server-side `attention_changed` broadcast; we stay on /attention
      // and watch the row disappear from the live list.
      await page.getByRole("button", { name: /^Approve$/ }).first().click();

      // 2s ceiling matches the brief — if the WS-driven refetch is slow we
      // want the test to fail loudly rather than silently padding the wait.
      await expect(page.getByText(label, { exact: true })).toHaveCount(0, {
        timeout: 2_000,
      });
      await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
      await expect(page.getByLabel(/items? needing attention/)).toHaveCount(0);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });
});
