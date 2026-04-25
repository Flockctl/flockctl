import { test, expect, type Page } from "@playwright/test";
import {
  buildMockTasks,
  routeTasksEndpoints,
  TOTAL_MOCK_TASKS,
} from "./fixtures/tasks-page";

/**
 * /tasks page Table view baseline protection.
 *
 * The Table view holds the saved-filter / CSV-export workflows users
 * depend on; its DOM and column order are a hard contract. The /tasks page
 * also exposes a Kanban view (`?view=kanban`); the two views are mutually
 * exclusive and unknown `?view=` values silently degrade to the table.
 *
 * Coverage map:
 *   1. default (no `?view=`) route mounts the Table view             → snapshot
 *   2. table renders 7 columns in the new order                      (no snapshot)
 *      (Status, ID, AI Key, Model, Created, Duration, Actions)
 *   3. pagination bar shows 20 rows and a correct "of 502" count     (no snapshot)
 *   4. `?view=kanban` does NOT mount the Table view                  (no snapshot)
 *   5. legacy `?view=cards` silently degrades to the Table view      (no snapshot)
 *
 * Regenerate the baseline with:
 *
 *   npm run e2e:update -- ui/e2e/tasks-table.spec.ts
 */

// Freeze animations / caret so the snapshot diff is stable across runs.
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

async function waitTableView(page: Page) {
  await expect(page.getByTestId("tasks-table-view")).toBeVisible({
    timeout: 15_000,
  });
  // First-row indicator — the mock stats endpoint resolves fast enough
  // that by the time the first row renders, the KPI skeletons are gone.
  await expect(page.getByRole("row").nth(1)).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    const skeletons = await page
      .locator('[data-slot="skeleton"]')
      .count();
    expect(skeletons).toBe(0);
  }).toPass({ timeout: 15_000 });
}

test.describe("tasks table view (baseline protection)", () => {
  test("baseline table view matches snapshot", async ({ page }) => {
    await routeTasksEndpoints(page, { tasks: buildMockTasks() });
    // Default `/tasks` — no query string — must resolve to the Table
    // view. Saved filter URLs link here; silently redirecting to Cards
    // would break them.
    await page.goto("/tasks");
    await waitTableView(page);

    // Structural sanity: the Kanban view shell must NOT be mounted when
    // the default `/tasks` is visited. If it is, a user with a saved
    // `?status=failed` filter URL would land on Kanban instead.
    await expect(page.getByTestId("tasks-kanban-view")).toHaveCount(0);

    await freeze(page);
    // fullPage so we catch layout shifts in the KPI bar as well as the
    // table — both live above the fold on a 1280-wide viewport and both
    // participate in the "pre-slice appearance" contract.
    await expect(page).toHaveScreenshot("tasks-table-baseline.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("table renders the seven-column header in the legacy order", async ({
    page,
  }) => {
    await routeTasksEndpoints(page, { tasks: buildMockTasks() });
    await page.goto("/tasks");
    await waitTableView(page);

    // The column order and labels are part of the pre-slice contract —
    // saved filter workflows + CSV exports assume these exact headers.
    const header = page.locator("thead tr").first();
    const headers = header.locator("th");
    await expect(headers).toHaveCount(7);
    await expect(headers.nth(0)).toHaveText("Status");
    await expect(headers.nth(1)).toHaveText("ID");
    await expect(headers.nth(2)).toHaveText("AI Key");
    await expect(headers.nth(3)).toHaveText("Model");
    await expect(headers.nth(4)).toHaveText("Created");
    await expect(headers.nth(5)).toHaveText("Duration");
    await expect(headers.nth(6)).toHaveText("Actions");
  });

  test("pagination shows 20 rows and the correct total", async ({ page }) => {
    await routeTasksEndpoints(page, { tasks: buildMockTasks() });
    await page.goto("/tasks");
    await waitTableView(page);

    // The table paginates at PAGE_SIZE (20). 502 total → page 1 of 26.
    const dataRows = page.locator("tbody tr");
    await expect(dataRows).toHaveCount(20);
    await expect(
      page.getByText(
        new RegExp(`Showing\\s+1.20\\s+of\\s+${TOTAL_MOCK_TASKS}\\s+tasks`),
      ),
    ).toBeVisible();

    // Previous is disabled on page 1 — a regression that enables it on
    // the zeroth page would let users page into negative offsets.
    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  test("?view=kanban does not mount the Table view", async ({ page }) => {
    await routeTasksEndpoints(page, { tasks: buildMockTasks() });
    await page.goto("/tasks?view=kanban");

    // Dispatcher picked the Kanban shell, so the Table shell is absent.
    // This is the flipside of the "default = table" contract — the two
    // views are mutually exclusive.
    await expect(page.getByTestId("tasks-kanban-view")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("tasks-table-view")).toHaveCount(0);
  });

  test("legacy ?view=cards silently degrades to the Table view", async ({
    page,
  }) => {
    await routeTasksEndpoints(page, { tasks: buildMockTasks() });
    // The Cards view was removed; bookmarks pointing at it must land on
    // the Table view (the documented `?view=` fallback) so saved URLs
    // don't 404 or render an empty page.
    await page.goto("/tasks?view=cards");
    await waitTableView(page);

    await expect(page.getByTestId("tasks-table-view")).toBeVisible();
    await expect(page.getByTestId("tasks-kanban-view")).toHaveCount(0);
  });
});
