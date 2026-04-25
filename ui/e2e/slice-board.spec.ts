import { test, expect, type Page } from "@playwright/test";
import { seedSliceBoardProject, SLICE_COUNTS } from "./fixtures/slice-board";

/**
 * Milestone 09 / slice 01 — SliceBoard end-to-end.
 *
 * Coverage map:
 *   1. board renders slices in order within each column                 (no snapshot)
 *   2. clicking a card updates ?slice= in the URL and reload preserves it (no snapshot)
 *   3. 30-card Pending column scrolls inside the column, not the page  (no snapshot)
 *   4. populated-board visual baseline                                  → slice-board-populated.png
 *   5. empty-column placeholder visual baseline                         → slice-board-empty-column.png
 *   6. selected-card visual baseline                                    → slice-board-selected.png
 *   7. high-priority chip visual baseline                               → slice-card-priority-high.png
 *   8. medium-priority chip visual baseline                             → slice-card-priority-medium.png
 *   9. low-priority chip visual baseline                                → slice-card-priority-low.png
 *
 * Baselines live in `ui/e2e/__screenshots__/slice-board.spec.ts/...` (see
 * playwright.config.ts `snapshotPathTemplate`). Regenerate with:
 *
 *   npm run e2e:update -- ui/e2e/slice-board.spec.ts
 *
 * The SliceBoard lives inside `ProjectDetailBoardView` and is only mounted on
 * `?view=board` — every scenario deep-links there to bypass the tree view.
 */

// Strip animations + caret blink so pixel diffs are stable across retries.
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
 * Wait until the board shell and at least one slice card have painted.
 *
 * The board view fetches `/projects/:id/tree` via react-query on mount; the
 * `[data-testid='slice-board']` node appears synchronously with a skeleton,
 * so we wait on a concrete slice-card to confirm the tree has resolved.
 */
async function waitSliceBoard(page: Page) {
  await expect(page.getByTestId("project-detail-board-view")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("slice-board")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("slice-card").first()).toBeVisible({
    timeout: 15_000,
  });
}

/** Locator for a specific column by its data-column-id. */
function column(page: Page, columnId: string) {
  return page.locator(`[data-testid='slice-board-column'][data-column-id='${columnId}']`);
}

test.describe("slice-board e2e", () => {
  test("renders seeded slices into the three default columns in order", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceBoardProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    // Pending column holds every pending slice in the order we seeded them.
    // We read the `data-slice-id` list off the cards inside the column and
    // compare against the fixture's return value — a strict equality guards
    // against both reordering *and* missing cards.
    const pendingIds = await column(page, "pending")
      .locator("[data-testid='slice-card']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-slice-id")),
      );
    expect(pendingIds).toEqual(proj.sliceIds.pending);

    const activeIds = await column(page, "active")
      .locator("[data-testid='slice-card']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-slice-id")),
      );
    expect(activeIds).toEqual(proj.sliceIds.active);

    // Verifying column is hidden from DEFAULT_SLICE_COLUMNS until the
    // backend starts emitting the status — see the JSDoc on that array.
    await expect(column(page, "verifying")).toHaveCount(0);

    const completedIds = await column(page, "completed")
      .locator("[data-testid='slice-card']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-slice-id")),
      );
    expect(completedIds).toEqual(proj.sliceIds.completed);

    // Column count badges mirror the card counts — a simple sanity gate that
    // SliceBoardColumn's `data-column-count` stays in lockstep with the
    // children it rendered.
    await expect(
      column(page, "pending").locator(
        "[data-testid='slice-board-column-count']",
      ),
    ).toHaveText(String(SLICE_COUNTS.pending));
    await expect(
      column(page, "active").locator(
        "[data-testid='slice-board-column-count']",
      ),
    ).toHaveText(String(SLICE_COUNTS.active));
  });

  test("clicking a card writes ?slice= to the URL and reload preserves the selection", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceBoardProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    const targetId = proj.sliceIds.completed[0];
    expect(targetId).toBeTruthy();
    const target = page.locator(
      `[data-testid='slice-card'][data-slice-id='${targetId}']`,
    );
    await expect(target).toBeVisible();

    await target.click();

    // URL picks up `?slice=<id>` (and may carry `?view=board` + a milestone
    // id depending on the ProjectTreePanel's default). We only care that the
    // slice param lands — the rest of the query bag is not our contract.
    await expect(page).toHaveURL(
      new RegExp(`[?&]slice=${encodeURIComponent(targetId)}(&|$)`),
    );
    await expect(target).toHaveAttribute("data-selected", "true");

    // A hard reload via page.reload() keeps the query string intact and the
    // board should rehydrate with the same card still selected. This is the
    // URL-is-source-of-truth contract for selection.
    await page.reload();
    await waitSliceBoard(page);

    const reloaded = page.locator(
      `[data-testid='slice-card'][data-slice-id='${targetId}']`,
    );
    await expect(reloaded).toBeVisible();
    await expect(reloaded).toHaveAttribute("data-selected", "true");

    // Only ONE card is selected — the ring must never double-apply.
    const selectedCount = await page
      .locator("[data-testid='slice-card'][data-selected='true']")
      .count();
    expect(selectedCount).toBe(1);
  });

  test("30-card Pending column scrolls within the column, not the page", async ({
    page,
    request,
  }) => {
    const proj = await seedSliceBoardProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    // Sanity: the seeded Pending column really does have 30 cards.
    await expect(
      column(page, "pending").locator("[data-testid='slice-card']"),
    ).toHaveCount(SLICE_COUNTS.pending);

    // The card stack inside the column is the second direct child — the
    // first is the header, the second is `<div class="flex flex-col gap-2
    // overflow-y-auto">` that owns the cards. Targeting it by index avoids
    // coupling the test to class-name stability.
    const cardStack = column(page, "pending").locator("> div").nth(1);

    // Contract under test: however tall the 30-card column gets, the
    // document itself must NOT grow vertically to accommodate it. The
    // outer column has `overflow-hidden` which clips any vertical
    // overflow, so the page stays within the viewport and the rest of
    // the mission-control chrome (KPI bar, breadcrumbs) never gets
    // shoved out of reach.
    const pageScrollHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (viewport) {
      // Small tolerance for sub-pixel rounding + scrollbar reservation.
      expect(pageScrollHeight).toBeLessThanOrEqual(viewport.height + 4);
    }

    // A programmatic scroll of the window must be a no-op — there is
    // nothing off-page to scroll to. If the column ever lost its
    // overflow containment, the 30 cards would push the document below
    // the fold and `window.scrollY` would move here.
    await page.evaluate(() => window.scrollTo(0, 9999));
    const afterPageY = await page.evaluate(() => window.scrollY);
    expect(afterPageY).toBe(0);

    // Cards past the column's fold may or may not be visible depending on
    // the viewport height, but every one of them must be in the DOM —
    // virtualisation would silently skip the "30 cards fit in the column"
    // contract and we want that to fail loud.
    await expect(
      column(page, "pending").locator("[data-testid='slice-card']"),
    ).toHaveCount(SLICE_COUNTS.pending);

    // The card stack itself owns the clipping geometry — confirm its
    // computed overflow-y is `auto` so a future refactor that drops
    // the `overflow-y-auto` utility gets flagged here.
    const overflowY = await cardStack.evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).overflowY,
    );
    expect(overflowY).toBe("auto");
  });

  test("populated board visual baseline", async ({ page, request }) => {
    const proj = await seedSliceBoardProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    await freeze(page);
    // Snapshot only the board — the KPI bar, tree panel and context rail
    // carry their own baselines, and including them here would re-capture
    // them every time anything on the page shifts.
    await expect(page.getByTestId("slice-board")).toHaveScreenshot(
      "slice-board-populated.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("empty column placeholder visual baseline", async ({ page, request }) => {
    const proj = await seedSliceBoardProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    // The fixture seeds every default column populated, so we flip every
    // Active slice back to `pending` via the API to drain the Active column.
    // The "No slices" placeholder then has to render. (Previously this
    // targeted the Verifying column; that column was dropped from
    // DEFAULT_SLICE_COLUMNS because the backend never produces the status.)
    for (const id of proj.sliceIds.active) {
      const res = await request.patch(
        `/projects/${proj.projectId}/milestones/${proj.milestoneId}/slices/${id}`,
        { data: { status: "pending" } },
      );
      expect(res.status()).toBe(200);
    }

    // Re-navigate to force a fresh tree fetch (react-query's cache doesn't
    // know we mutated on the server side out of band).
    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitSliceBoard(page);

    const active = column(page, "active");
    await expect(
      active.locator("[data-testid='slice-board-column-empty']"),
    ).toHaveText("No slices");

    await freeze(page);
    await expect(active).toHaveScreenshot("slice-board-empty-column.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("selected card visual baseline", async ({ page, request }) => {
    const proj = await seedSliceBoardProject(request);

    const targetId = proj.sliceIds.completed[0];
    // Deep-link the selection so the snapshot captures the ring without a
    // click animation frame adding wobble.
    await page.goto(
      `/projects/${proj.projectId}?view=board&slice=${encodeURIComponent(targetId)}`,
    );
    await waitSliceBoard(page);

    const selected = page.locator(
      `[data-testid='slice-card'][data-slice-id='${targetId}']`,
    );
    await expect(selected).toHaveAttribute("data-selected", "true");

    await freeze(page);
    await expect(selected).toHaveScreenshot("slice-board-selected.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  /**
   * Priority chip snapshots.
   *
   * The backend `PlanSlice` type does NOT carry a priority field today —
   * that's a UI-side affordance reserved for a future data migration (see
   * the long comment on SliceCard). For now we render the chip variants
   * directly via `page.evaluate`, injecting the exact Badge markup that
   * `priorityChip()` produces into an existing slice card and then taking
   * a focused screenshot.
   *
   * Injecting into a real rendered card (rather than a synthetic data: URL)
   * means the snapshot uses the real Tailwind CSS bundle, so a class-name
   * rename in `badgeVariants` will flag as a pixel diff.
   */
  const priorities: Array<{
    level: "high" | "medium" | "low";
    variant: "destructive" | "secondary" | "outline";
    extraClasses: string;
    file: string;
  }> = [
    {
      level: "high",
      variant: "destructive",
      extraClasses: "text-[10px]",
      file: "slice-card-priority-high.png",
    },
    {
      level: "medium",
      variant: "secondary",
      extraClasses:
        "text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400",
      file: "slice-card-priority-medium.png",
    },
    {
      level: "low",
      variant: "outline",
      extraClasses: "text-[10px] text-muted-foreground",
      file: "slice-card-priority-low.png",
    },
  ];

  for (const p of priorities) {
    test(`${p.level} priority chip visual baseline`, async ({
      page,
      request,
    }) => {
      const proj = await seedSliceBoardProject(request);

      await page.goto(`/projects/${proj.projectId}?view=board`);
      await waitSliceBoard(page);

      // Pick the first Active card — short column, predictable geometry,
      // and the status colour (primary) contrasts with each chip variant
      // so the baseline isn't confusable with a status-only render.
      const targetId = proj.sliceIds.active[0];
      const card = page.locator(
        `[data-testid='slice-card'][data-slice-id='${targetId}']`,
      );
      await expect(card).toBeVisible();

      // Inject a Badge sibling into the breadcrumb row to mirror the exact
      // DOM that `priorityChip()` would produce. Relying on the real Badge
      // classes keeps the snapshot faithful to production rendering.
      await card.evaluate(
        (el, { level, variant, extraClasses }) => {
          const breadcrumb = el.querySelector(
            "[data-testid='slice-card-breadcrumb']",
          );
          if (!breadcrumb || !breadcrumb.parentElement) return;
          const badge = document.createElement("span");
          badge.setAttribute("data-slot", "badge");
          badge.setAttribute("data-variant", variant);
          badge.setAttribute("data-priority", level);
          // These are the exact classes emitted by `badgeVariants({ variant })`
          // in `ui/src/components/ui/badge.tsx` plus the priority-specific
          // overrides from `priorityChip()`. Kept in lockstep with those two
          // source files on purpose — a class rename there should fail this
          // snapshot on the next run.
          const baseClasses =
            "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all";
          const variantClasses: Record<string, string> = {
            destructive:
              "bg-destructive/10 text-destructive dark:bg-destructive/20",
            secondary: "bg-secondary text-secondary-foreground",
            outline: "border-border text-foreground",
          };
          badge.className = `${baseClasses} ${variantClasses[variant]} ${extraClasses}`;
          badge.textContent = level;
          breadcrumb.parentElement.appendChild(badge);
        },
        { level: p.level, variant: p.variant, extraClasses: p.extraClasses },
      );

      await freeze(page);
      await expect(card).toHaveScreenshot(p.file, {
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
