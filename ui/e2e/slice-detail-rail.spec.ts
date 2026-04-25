import { test, expect, type Page } from "@playwright/test";
import {
  seedSliceRailProject,
  SCROLL_TASK_COUNT,
} from "./fixtures/slice-detail-rail";

/**
 * Milestone 09 / slice 02 — `SliceDetailPanel` right-rail end-to-end.
 *
 * Coverage map:
 *   1. click → rail update → action buttons                          (no snapshot)
 *   2. disabled Re-run tooltip when auto-exec is running             (no snapshot)
 *   3. not-found state when the ?slice= slug doesn't match any slice (no snapshot)
 *   4. empty rail placeholder visual baseline                        → slice-rail-empty.png
 *   5. rail with a selected slice visual baseline                    → slice-rail-with-slice.png
 *   6. 150-char title wraps to 3 lines visual baseline               → slice-rail-long-title-wraps.png
 *   7. 20-task scroll visual baseline                                → slice-rail-many-tasks-scrolls.png
 *
 * Baselines live in `ui/e2e/__screenshots__/slice-detail-rail.spec.ts/...`
 * (see `playwright.config.ts` `snapshotPathTemplate`). Regenerate with:
 *
 *   npm run e2e:update -- ui/e2e/slice-detail-rail.spec.ts
 *
 * The rail is only mounted in board view — every scenario deep-links via
 * `?view=board` to bypass the tree-view default.
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

/** Wait for the board + the rail wrapper to paint. */
async function waitBoard(page: Page) {
  await expect(page.getByTestId("project-detail-board-view")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("slice-board")).toBeVisible({ timeout: 15_000 });
}

/**
 * Intercept GET `/projects/:id/milestones/:m/auto-execute` so the rail sees a
 * deterministic "running" status. The Re-run button only disables when the
 * status hook reports `running` or includes the active slice in
 * `current_slice_ids` — driving the real auto-executor would race the test
 * and leave the disabled state flaky.
 */
async function routeAutoExecRunning(
  page: Page,
  milestoneSlug: string,
  currentSliceSlug: string,
) {
  await page.route(
    new RegExp(
      `/projects/\\d+/milestones/${milestoneSlug}/auto-execute(\\?|$)`,
    ),
    async (route) => {
      const req = route.request();
      if (req.resourceType() === "document") return route.fallback();
      if (req.method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "running",
          milestone_id: milestoneSlug,
          current_slice_ids: [currentSliceSlug],
          started_at: "2026-04-23T12:00:00.000Z",
          completed_slices: 0,
          total_slices: 1,
        }),
      });
    },
  );
}

test.describe("slice-detail-rail e2e", () => {
  test("click on a board card updates the rail and exposes the action buttons", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitBoard(page);

    // No selection → rail shows the board-right empty hint, not the panel.
    await expect(page.getByTestId("board-right-empty")).toBeVisible();
    await expect(page.getByTestId("slice-detail-panel")).toHaveCount(0);

    // Click the scroll-fixture card (the one with 20 tasks). The URL picks
    // up `?slice=` and the rail swaps from the empty-state div to the
    // panel body — that transition is what the unit spec at
    // `ui/src/__tests__/components/board_view_rail.test.tsx` asserts in
    // isolation; here we verify it end-to-end over the real API.
    await page
      .locator(
        `[data-testid='slice-card'][data-slice-id='${proj.scrollSliceSlug}']`,
      )
      .click();

    await expect(page).toHaveURL(
      new RegExp(`[?&]slice=${proj.scrollSliceSlug}(&|$)`),
    );
    await expect(page.getByTestId("board-right-empty")).toHaveCount(0);

    const panel = page.getByTestId("slice-detail-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-slice-id", proj.scrollSliceSlug);

    // All three action buttons render and (in the idle auto-exec state) are
    // enabled. The Re-run disabled state is covered by its own test below.
    await expect(page.getByTestId("slice-detail-panel-rerun")).toBeEnabled();
    await expect(page.getByTestId("slice-detail-panel-chat")).toBeEnabled();
    await expect(page.getByTestId("slice-detail-panel-copy-id")).toBeEnabled();

    // The tasks list materialised from the 20-task seed — contract gate that
    // the rail and the fixture both agree on the count.
    await expect(
      page.locator("[data-testid='slice-detail-panel-task-list'] > li"),
    ).toHaveCount(SCROLL_TASK_COUNT);
  });

  test("Re-run is disabled with a tooltip when auto-execution is running for this milestone", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    // Installed before navigation so the rail's first `useAutoExecStatus`
    // fetch is already intercepted — no transient "enabled" flash.
    await routeAutoExecRunning(
      page,
      proj.milestoneSlug,
      proj.runningSliceSlug,
    );

    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=${proj.runningSliceSlug}`,
    );
    await waitBoard(page);

    const rerun = page.getByTestId("slice-detail-panel-rerun");
    await expect(rerun).toBeVisible();
    await expect(rerun).toBeDisabled();
    await expect(rerun).toHaveAttribute(
      "title",
      "Auto-execution is already running for this milestone",
    );
  });

  test("renders the not-found hint when the ?slice= slug is unknown", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=ghost-slice-slug`,
    );
    await waitBoard(page);

    // The slug is a valid-shaped slug (lowercase-hyphen) so `useSelection`
    // lets it through, but no slice with that id exists in the tree —
    // the panel drops into its not-found branch.
    await expect(
      page.getByTestId("slice-detail-panel-not-found"),
    ).toBeVisible();
    await expect(page.getByTestId("slice-detail-panel")).toHaveCount(0);
    // Action buttons MUST NOT render in the not-found state.
    await expect(page.getByTestId("slice-detail-panel-rerun")).toHaveCount(0);
    await expect(page.getByTestId("slice-detail-panel-chat")).toHaveCount(0);
  });

  // --- Visual baselines -------------------------------------------------

  test("empty rail visual baseline", async ({ page, request }) => {
    const proj = await seedSliceRailProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitBoard(page);

    await expect(page.getByTestId("board-right-empty")).toBeVisible();

    await freeze(page);
    await expect(page.getByTestId("board-right-empty")).toHaveScreenshot(
      "slice-rail-empty.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("rail with selected slice visual baseline", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    // Deep-link to the scroll-fixture slice but capture the rail in its
    // initial-viewport state (no scroll offset yet) so the baseline stays
    // stable — the many-tasks scroll baseline below scrolls intentionally.
    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=${proj.scrollSliceSlug}`,
    );
    await waitBoard(page);

    const panel = page.getByTestId("slice-detail-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-slice-id", proj.scrollSliceSlug);

    await freeze(page);
    await expect(panel).toHaveScreenshot("slice-rail-with-slice.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("150-char title wraps to three lines visual baseline", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=${proj.longTitleSliceSlug}`,
    );
    await waitBoard(page);

    const title = page.getByTestId("slice-detail-panel-title");
    await expect(title).toBeVisible();

    // Contract gate: the title node carries `line-clamp-3`. If a future
    // refactor strips the utility, the baseline will drift — but this
    // runtime check fails first with a clearer error message.
    await expect(title).toHaveClass(/line-clamp-3/);

    await freeze(page);
    await expect(title).toHaveScreenshot(
      "slice-rail-long-title-wraps.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("20-task slice scrolls within the rail visual baseline", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceRailProject(request);

    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=${proj.scrollSliceSlug}`,
    );
    await waitBoard(page);

    const list = page.getByTestId("slice-detail-panel-task-list");
    await expect(list).toBeVisible();
    await expect(list.locator("> li")).toHaveCount(SCROLL_TASK_COUNT);

    // Contract under test: the list caps its height with `max-h-[60vh]` and
    // owns an `overflow-y-auto` scroll container, so a 20-task seed must
    // scroll INSIDE the rail — it must NOT push the page scrollHeight past
    // the viewport.
    const overflowY = await list.evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).overflowY,
    );
    expect(overflowY).toBe("auto");

    const pageScrollHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const viewport = page.viewportSize();
    if (viewport) {
      // Small tolerance for sub-pixel rounding + scrollbar reservation.
      expect(pageScrollHeight).toBeLessThanOrEqual(viewport.height + 4);
    }

    // Scroll the list to the bottom so the baseline captures the scrolled
    // state (tail of the 20 tasks visible). The `scrollIntoView` on the
    // last <li> is more robust than hard-coding a pixel offset — it works
    // regardless of per-row padding changes.
    const lastRow = list.locator("> li").last();
    await lastRow.scrollIntoViewIfNeeded();

    await freeze(page);
    await expect(list).toHaveScreenshot("slice-rail-many-tasks-scrolls.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
