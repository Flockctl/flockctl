import { test, expect } from "@playwright/test";
import { createProject, createTask } from "./_helpers";

/**
 * E2E coverage for the task-detail Diff tab swap (slice 03).
 *
 * The legacy `<InlineDiff>` viewer was replaced with the Monaco-backed
 * {@link "@/components/TaskDiffMonacoView"}. The contract this spec
 * pins:
 *
 *   1. The "Show Diff" button on a task with a populated
 *      `git_diff_summary` opens the Monaco view (not the old
 *      file-cards renderer). We assert on the
 *      `task-diff-monaco` testid that the new component owns.
 *   2. The sidebar lists every file in the unified diff, with the
 *      first one auto-selected — operators should see the change list
 *      at a glance.
 *   3. A baseline screenshot guards against accidental layout drift
 *      on the file-list pane.
 *
 * The task fetch and `/tasks/:id/diff` endpoint are stubbed with
 * `page.route` so we don't depend on a real Claude run shaping the
 * change-set. Everything else (logs, questions, …) hits the real
 * daemon the playwright config boots.
 */

const UNIFIED_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 0000001..0000002 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,3 @@",
  " keep this line",
  "-removed line",
  "+added line",
  " trailing context",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 0000003..0000004 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1 +1,2 @@",
  " unchanged",
  "+brand new line",
].join("\n");

test("task-detail Diff tab renders the Monaco-backed viewer with a file sidebar", async ({
  page,
  request,
}) => {
  const proj = await createProject(request);
  const task = await createTask(request, proj.id, {
    prompt: "task-detail-diff-monaco-check",
  });

  // Stub the task fetch so `git_diff_summary` is populated — that's the
  // gate for the "Show Diff" button on a non-pending-approval task.
  // The page navigation to `/tasks/<id>` (HTML document) shares the same
  // path with the React-Query fetch (JSON XHR/fetch); we only want to
  // intercept the data fetch — the document load must hit Vite's SPA
  // fallback or we'd trip a JSON parse on the index.html bytes.
  await page.route(`**/tasks/${task.id}`, async (route) => {
    const req = route.request();
    if (req.method() !== "GET" || req.resourceType() === "document") {
      return route.fallback();
    }
    const upstream = await route.fetch();
    const payload = (await upstream.json()) as Record<string, unknown>;
    payload.git_diff_summary = "2 files changed, 2 insertions(+), 1 deletion(-)";
    payload.status = "done";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  // Stub the diff endpoint with our deterministic two-file unified diff.
  await page.route(`**/tasks/${task.id}/diff`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        diff: UNIFIED_DIFF,
        summary: "2 files changed, 2 insertions(+), 1 deletion(-)",
        truncated: false,
        total_lines: 6,
        total_files: 2,
        total_entries: 2,
      }),
    });
  });

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("task-detail-diff-monaco-check").first()).toBeVisible({
    timeout: 10_000,
  });

  // Click "Show Diff" — the button mounted on the diff-summary card.
  await page.getByRole("button", { name: "Show Diff" }).click();

  // The new Monaco-backed view replaces the old `InlineDiff` cards.
  const view = page.getByTestId("task-diff-monaco");
  await expect(view).toBeVisible({ timeout: 10_000 });
  await expect(view).toHaveAttribute("data-file-count", "2");

  // Sidebar lists both files in input order; first file is auto-active.
  const rows = page.getByTestId("task-diff-monaco-file");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-path", "src/foo.ts");
  await expect(rows.nth(0)).toHaveAttribute("data-active", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-path", "src/bar.ts");

  // Selecting the second file flips the active row.
  await rows.nth(1).click();
  await expect(rows.nth(0)).toHaveAttribute("data-active", "false");
  await expect(rows.nth(1)).toHaveAttribute("data-active", "true");

  // Baseline screenshot — guards against layout drift on the file-list
  // pane. Only the sidebar is captured (Monaco itself is exercised by
  // the unit tests; its inner DOM is not stable enough for a snapshot).
  await expect(page.getByTestId("task-diff-monaco-files")).toHaveScreenshot(
    "task-detail-diff-monaco.png",
  );
});
