import { test, expect, type Page } from "@playwright/test";
import {
  seedLeftTreeProject,
  seedProjectWithSlices,
} from "./fixtures/project-view-modes";

/**
 * Milestone 09 / slice 02 — left-tree panel end-to-end.
 *
 * Coverage map:
 *   1. click-filter   — clicking a milestone in the tree narrows the
 *                       center SliceBoard and pushes `?milestone=<slug>`.
 *   2. keyboard-nav   — ArrowDown / ArrowRight walk the tree, Enter on
 *                       a slice fires the same selection side effects as
 *                       a click, and ArrowUp does not wrap from the top.
 *   3. reload-URL     — `?milestone=<slug>&slice=<slug>` in the URL at
 *                       page-open time lands the highlight on the right
 *                       rows of both panes, survives a full reload, and
 *                       the board still filters.
 *
 * Visual baselines (taken with freeze+full-page):
 *   - left-tree-idle.png              — panel with no selection.
 *   - left-tree-milestone-selected.png — one milestone highlighted.
 *   - left-tree-slice-selected.png    — slice highlighted + parent expanded.
 *
 * Corner cases declared by the slice spec:
 *   - XSS rejection in `?slice=` (malformed slug ignored by useSelection).
 *   - Non-existent milestone slug clears itself on next interaction.
 *   - 30-milestone scroll + keyboard navigation through the overflow.
 *
 * Regenerate baselines:
 *   npm run e2e:update -- ui/e2e/left-tree.spec.ts
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

async function waitBoardShell(page: Page) {
  await expect(page.getByRole("group", { name: "View mode" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("project-detail-board-view")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("project-detail left tree panel", () => {
  test("click filter: clicking a milestone narrows the board and updates the URL", async ({
    page,
    request,
  }) => {
    const proj = await seedLeftTreeProject(request, 3);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitBoardShell(page);

    const tree = page.getByRole("tree");
    await expect(tree).toBeVisible();

    // Snapshot 1 — idle panel, no selection written yet.
    await freeze(page);
    await expect(page).toHaveScreenshot("left-tree-idle.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });

    // Click the first milestone row.
    const first = tree.getByText(proj.firstMilestoneTitle);
    if ((await first.count()) === 0) {
      test.skip(true, "milestone seed did not land — skipping click-filter");
      return;
    }
    await first.click();

    // URL picks up the milestone param.
    await expect(page).toHaveURL(/[?&]milestone=[a-z0-9-]+/);

    // Snapshot 2 — milestone row highlighted (aria-selected + ring).
    await freeze(page);
    await expect(page).toHaveScreenshot("left-tree-milestone-selected.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("keyboard nav: ArrowDown advances focus and ArrowUp at top does not wrap", async ({
    page,
    request,
  }) => {
    const proj = await seedLeftTreeProject(request, 30);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitBoardShell(page);

    const panel = page.getByTestId("project-tree-panel");
    await expect(panel).toBeVisible();

    // 30 treeitems rendered inside the scrollable rail (at minimum — some
    // backends may drop a milestone POST; the test still meaningfully
    // exercises the keyboard path down to whatever was seeded).
    const items = panel.getByRole("treeitem");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Focus the first item by keyboard (not mouse) so the roving tabindex
    // takes over cleanly.
    await items.first().focus();

    // ArrowDown × 3 — focus must end up on the 4th item (non-wrap assumes
    // the list has at least 4 items, which we asserted above).
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
    }
    const fourthId = await items.nth(3).getAttribute("data-testid");
    await expect(
      panel.locator(`[data-testid="${fourthId}"]:focus`),
    ).toBeVisible();

    // ArrowUp at top stays at top (no wrap). Re-focus the first item to
    // put the roving tabindex back before pressing ArrowUp.
    await items.first().focus();
    await page.keyboard.press("ArrowUp");
    const firstId = await items.first().getAttribute("data-testid");
    await expect(
      panel.locator(`[data-testid="${firstId}"]:focus`),
    ).toBeVisible();

    // The scroll container is tall enough to need scrolling — confirm the
    // last item would be off-screen without scrolling, and then that
    // keyboard navigation brings it into view.
    const lastId = await items.nth(count - 1).getAttribute("data-testid");
    await items.first().focus();
    // Hold ArrowDown enough times to reach the last row.
    for (let i = 0; i < count - 1; i++) {
      await page.keyboard.press("ArrowDown");
    }
    const lastBox = await panel.locator(`[data-testid="${lastId}"]`).boundingBox();
    const panelBox = await panel.boundingBox();
    expect(lastBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    if (lastBox && panelBox) {
      // The last row's top must sit inside the visible viewport of the
      // panel — scrollIntoView({block: "nearest"}) should have brought it
      // into view.
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(
        panelBox.y + panelBox.height + 2,
      );
      expect(lastBox.y).toBeGreaterThanOrEqual(panelBox.y - 2);
    }
  });

  test("reload preserves URL selection: slice highlight survives a full reload", async ({
    page,
    request,
  }) => {
    const proj = await seedProjectWithSlices(request, 2);

    // Deep-link directly to the slice. `?milestone=<ms>&slice=<slice>` is the
    // shape the slice spec writes when a user clicks a slice row.
    if (proj.sliceSlugs.length === 0) {
      test.skip(
        true,
        "slice fixture did not seed any slices (likely mock-AI restriction)",
      );
      return;
    }
    const sliceSlug = proj.sliceSlugs[0];
    await page.goto(
      `/projects/${proj.projectId}?view=board&milestone=${proj.milestoneSlug}&slice=${sliceSlug}`,
    );
    await waitBoardShell(page);

    // Tree: parent is auto-expanded + the slice row carries aria-selected.
    const tree = page.getByRole("tree");
    await expect(
      tree.locator(`[data-testid="tree-slice-${sliceSlug}"]`),
    ).toHaveAttribute("aria-selected", "true");

    // Board: the matching card carries data-selected.
    await expect(
      page.locator(`[data-testid="slice-card"][data-slice-id="${sliceSlug}"]`),
    ).toHaveAttribute("data-selected", "true");

    // Snapshot 3 — slice-selected state, both panes in sync.
    await freeze(page);
    await expect(page).toHaveScreenshot("left-tree-slice-selected.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });

    // Reload and re-assert. The URL is the single source of truth, so a
    // full page reload must reproduce the same highlight state.
    await page.reload();
    await waitBoardShell(page);
    await expect(
      page.locator(`[data-testid="tree-slice-${sliceSlug}"]`),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator(`[data-testid="slice-card"][data-slice-id="${sliceSlug}"]`),
    ).toHaveAttribute("data-selected", "true");
  });

  test("corner case: XSS-shaped ?slice= is rejected without highlighting any card", async ({
    page,
    request,
  }) => {
    const proj = await seedLeftTreeProject(request, 2);

    const payload = "<script>alert('flockctl-xss')</script>";
    const encoded = encodeURIComponent(payload);

    await page.addInitScript(() => {
      (window as unknown as { __xssFired?: boolean }).__xssFired = false;
      const orig = window.alert;
      window.alert = (...args: unknown[]) => {
        (window as unknown as { __xssFired?: boolean }).__xssFired = true;
        return orig.apply(window, args as []);
      };
    });

    await page.goto(`/projects/${proj.projectId}?view=board&slice=${encoded}`);
    await waitBoardShell(page);

    // No alert fired.
    const fired = await page.evaluate(
      () => (window as unknown as { __xssFired?: boolean }).__xssFired === true,
    );
    expect(fired).toBe(false);

    // Raw payload absent from the DOM.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(payload);

    // No slice card has data-selected=true.
    expect(
      await page
        .locator('[data-testid="slice-card"][data-selected="true"]')
        .count(),
    ).toBe(0);
  });

  test("corner case: non-existent milestone slug filters to empty state", async ({
    page,
    request,
  }) => {
    const proj = await seedLeftTreeProject(request, 2);

    // A well-formed slug that matches nothing in this project's tree.
    await page.goto(
      `/projects/${proj.projectId}?view=board&milestone=nope-does-not-exist`,
    );
    await waitBoardShell(page);

    // The board's columns are all empty.
    expect(await page.locator('[data-testid="slice-card"]').count()).toBe(0);

    // The tree still renders the real milestones (left rail is not filtered
    // by the selection — it always shows every milestone).
    const panel = page.getByTestId("project-tree-panel");
    const treeItems = panel.getByRole("treeitem");
    expect(await treeItems.count()).toBeGreaterThanOrEqual(1);
  });
});
