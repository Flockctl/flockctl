import { test, expect, type Page } from "@playwright/test";
import { seedViewModeProject, LONG_MILESTONE_TITLE } from "./fixtures/project-view-modes";

/**
 * Milestone 09 / slice 00 — URL-backed view-mode visual baselines.
 *
 * Coverage map:
 *   1. baseline /projects/:id renders the tree view                → snapshot
 *   2. clicking the board button in ViewModeToggle flips to board  → snapshot
 *   3. navigating directly to ?view=board renders the 3-col grid   → snapshot
 *   4. a 120-char milestone title does not overflow the grid       → snapshot
 *   + swimlane stub is advertised via ViewModeToggle and copy     (no snapshot)
 *   + XSS-shaped ?view= param is rejected and never reaches the DOM (no snapshot)
 *
 * Baselines live in `ui/e2e/__screenshots__/...` (see playwright.config.ts
 * `snapshotPathTemplate`). Regenerate with `npm run e2e:update`.
 */

// Disable animations + caret blink before snapshotting so the pixel diff is
// stable across retries. The prototype page uses tailwind transitions on
// hover/focus which otherwise flicker between runs.
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

// Wait for the project detail shell to finish its first render.
//
// The ViewModeToggle sits in the dispatcher and mounts for every view mode,
// so it is the one element that unambiguously signals "page is live" without
// coupling the wait to a specific view (tree shows a project heading, board
// shows only stubs). We still optionally take a project name to wait on when
// the caller needs the tree view's header to be painted — that extra wait is
// a no-op in board/swimlane because we skip it when `name` is null.
async function waitProjectShell(page: Page, name: string | null = null) {
  await expect(page.getByRole("group", { name: "View mode" })).toBeVisible({
    timeout: 15_000,
  });
  if (name) {
    await expect(page.getByRole("heading", { name }).first()).toBeVisible({
      timeout: 15_000,
    });
  }
}

test.describe("project-detail view modes", () => {
  test("baseline tree view matches snapshot", async ({ page, request }) => {
    const proj = await seedViewModeProject(request);

    await page.goto(`/projects/${proj.projectId}`);
    // Tree mode renders the project heading inside the tree view — wait on it
    // so the chart/stat skeletons are gone before snapshotting.
    await waitProjectShell(page, proj.projectName);

    // The toggle itself is the slice-00 artifact — it must be in the DOM on
    // the baseline view so the next test can click it.
    await expect(page.getByRole("group", { name: "View mode" })).toBeVisible();

    await freeze(page);
    await expect(page).toHaveScreenshot("tree-baseline.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("clicking the Board button in the toggle switches to board view", async ({
    page,
    request,
  }) => {
    const proj = await seedViewModeProject(request);

    await page.goto(`/projects/${proj.projectId}`);
    // Tree mode renders the project heading inside the tree view — wait on it
    // so the chart/stat skeletons are gone before snapshotting.
    await waitProjectShell(page, proj.projectName);

    // Click the board button inside the ViewModeToggle.
    const toggle = page.getByRole("group", { name: "View mode" });
    await toggle.getByRole("button", { name: /^Board$/ }).click();

    // URL updates in place — same pathname, `?view=board` appended.
    await expect(page).toHaveURL(/\/projects\/\d+\?.*view=board/);

    // Board view: the 3-col grid shell mounts.
    await expect(page.getByTestId("project-detail-board-view")).toBeVisible();

    // Board button is now `aria-pressed="true"`.
    await expect(
      toggle.getByRole("button", { name: /^Board$/ }),
    ).toHaveAttribute("aria-pressed", "true");

    await freeze(page);
    await expect(page).toHaveScreenshot("board-after-toggle.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("direct navigation to ?view=board loads the 3-column grid", async ({
    page,
    request,
  }) => {
    const proj = await seedViewModeProject(request);

    // Deep-link — no intermediate click. The hook must pick up the URL param
    // on first render and the board shell must mount straight away.
    await page.goto(`/projects/${proj.projectId}?view=board`);
    // Board mode shows only stubs (slice 00) so there is no project heading
    // to wait on — fall back to waiting for the toggle group.
    await waitProjectShell(page);

    const shell = page.getByTestId("project-detail-board-view");
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("data-view-mode", "board");

    // Three named slots are present — left (milestones), center (board),
    // right (context). These data-slot attributes are the contract between
    // slice 00 and slices 02/03/04.
    await expect(shell.locator('[data-slot="board-left"]')).toBeVisible();
    await expect(shell.locator('[data-slot="board-center"]')).toBeVisible();
    await expect(shell.locator('[data-slot="board-right"]')).toBeVisible();

    // Assert the computed grid has exactly three tracks. `getBoundingClientRect`
    // on each slot tells us the tracks are arranged horizontally and the
    // outer container is not wrapping. We check the computed
    // `grid-template-columns` for defence-in-depth so a future CSS change
    // (e.g. dropping to two columns on narrow viewports) fails here loudly.
    const gridTemplate = await shell.evaluate(
      (el) => window.getComputedStyle(el).gridTemplateColumns,
    );
    // grid-cols-[260px_1fr_360px] computes to three pixel tracks on the
    // desktop viewport (1280×720 in devices["Desktop Chrome"]).
    expect(gridTemplate.split(/\s+/).length).toBe(3);

    await freeze(page);
    await expect(page).toHaveScreenshot("board-direct-nav.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("120-char milestone title does not overflow the board grid", async ({
    page,
    request,
  }) => {
    const proj = await seedViewModeProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitProjectShell(page);

    const shell = page.getByTestId("project-detail-board-view");
    await expect(shell).toBeVisible();

    // The milestone may or may not have landed (mock-AI backends reject the
    // planning write). We still take the snapshot — the interesting case
    // for the overflow guarantee is when the title IS present, but the
    // no-milestone fallback is also a valid baseline to catch a regression
    // in the grid geometry itself.
    const titleLocator = page.getByText(LONG_MILESTONE_TITLE, { exact: false });
    if (await titleLocator.count()) {
      // Assert the title stays inside the left slot — its right edge cannot
      // extend past the left-slot's right edge.
      const title = titleLocator.first();
      await expect(title).toBeVisible();
      const [titleBox, leftBox] = await Promise.all([
        title.boundingBox(),
        shell.locator('[data-slot="board-left"]').boundingBox(),
      ]);
      if (titleBox && leftBox) {
        // Tolerate a 2px sub-pixel wobble in either direction.
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(
          leftBox.x + leftBox.width + 2,
        );
      }
    }

    // Regardless of whether the milestone row rendered, the shell's
    // bounding box must still fit inside the viewport — the overflow
    // guarantee is on the grid, not the content.
    const shellBox = await shell.boundingBox();
    expect(shellBox).not.toBeNull();
    if (shellBox) {
      const viewport = page.viewportSize();
      if (viewport) {
        expect(shellBox.x + shellBox.width).toBeLessThanOrEqual(
          viewport.width + 2,
        );
      }
    }

    await freeze(page);
    await expect(page).toHaveScreenshot("board-long-title.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("swimlane stub is advertised via ViewModeToggle and renders 'coming soon'", async ({
    page,
    request,
  }) => {
    const proj = await seedViewModeProject(request);

    await page.goto(`/projects/${proj.projectId}?view=swimlane`);
    await waitProjectShell(page);

    // The dispatcher renders a stub for non-tree modes (see
    // `ProjectDetailViewStub` in `project-detail.tsx`) OR the board shell
    // with a "coming soon" center hint. Either is acceptable — we check the
    // copy, which is the user-facing contract.
    await expect(page.getByText(/coming soon/i).first()).toBeVisible();

    // Toggle still flags swimlane as upcoming.
    const toggle = page.getByRole("group", { name: "View mode" });
    await expect(
      toggle.getByRole("button", { name: /Swimlane/ }),
    ).toContainText(/coming soon/i);
  });

  test("XSS-shaped ?view= param is silently rejected (falls back to tree)", async ({
    page,
    request,
  }) => {
    const proj = await seedViewModeProject(request);

    // `<script>alert(1)</script>` URL-encoded. If the hook ever dropped its
    // allow-list and echoed the raw param into the DOM, this payload would
    // either execute or appear verbatim. We want *neither* — the page must
    // behave as if no view param was supplied.
    const payload = "<script>alert('flockctl-xss')</script>";
    const encoded = encodeURIComponent(payload);

    // Hook into the browser to detect any injected script actually running.
    await page.addInitScript(() => {
      (window as unknown as { __xssFired?: boolean }).__xssFired = false;
      const orig = window.alert;
      window.alert = (...args: unknown[]) => {
        (window as unknown as { __xssFired?: boolean }).__xssFired = true;
        return orig.apply(window, args as []);
      };
    });

    await page.goto(`/projects/${proj.projectId}?view=${encoded}`);
    // Invalid params silently fall back to tree mode, where the project
    // heading is rendered by the tree view component.
    await waitProjectShell(page, proj.projectName);

    // The raw payload must NOT be anywhere in the rendered page body (it
    // could only get there via unescaped interpolation of the URL param).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(payload);

    // And no alert should have fired.
    const fired = await page.evaluate(
      () => (window as unknown as { __xssFired?: boolean }).__xssFired === true,
    );
    expect(fired).toBe(false);

    // Default view is 'tree', so the board shell must NOT be mounted.
    await expect(page.getByTestId("project-detail-board-view")).toHaveCount(0);
  });
});
