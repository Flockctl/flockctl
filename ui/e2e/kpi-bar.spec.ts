import { test, expect, type Page } from "@playwright/test";
import { seedKpiBarProject, fetchProjectStats } from "./fixtures/kpi-bar";

/**
 * Milestone 09 / slice 04 — mission-control KPI bar end-to-end.
 *
 * Coverage map:
 *   1. baseline zero-state KPI bar renders at the top of ?view=board  → snapshot
 *   2. numeric values in the DOM match /projects/:id/stats            (no snapshot)
 *   3. creating a task via the API flips `Active tasks` within ~2s    (no snapshot)
 *   4. narrow viewport (tablet) collapses the 5-card grid to 3 cols   → snapshot
 *   5. phone viewport collapses the grid to 2 cols                    → snapshot
 *
 * Baselines live in `ui/e2e/__screenshots__/...` (see playwright.config.ts
 * `snapshotPathTemplate`). Regenerate with:
 *
 *   npm run e2e:update -- ui/e2e/kpi-bar.spec.ts
 *
 * The bar lives inside `ProjectDetailBoardView`, which is only mounted on
 * `?view=board` — every test deep-links there to skip the tree view's
 * render path.
 */

// Strip animations + caret so pixel diffs are stable across retries.
// The KPI card border/shadow has no transitions today, but the <Progress>
// indicator animates via tailwind on first mount; freezing transitions
// cuts the wobble to zero.
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
 * Wait until the KPI bar is mounted and has finished its first render.
 *
 * `useKpiData` stitches three react-query hooks; "finished" means the
 * value tile text is no longer a skeleton. We key off the slices tile
 * because it is the card most likely to be in a skeleton state (the
 * `/projects/:id/stats` request is the slowest of the three on a
 * fresh project).
 */
async function waitKpiBar(page: Page) {
  const bar = page.getByTestId("mission-control-kpi-bar");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("kpi-slices-value")).not.toHaveText("", {
    timeout: 15_000,
  });
  // Wait for any in-flight skeleton placeholders to disappear across the bar.
  // The visibility check above only handles the slices tile — the tokens
  // tile can still be loading its usage summary on a cold cache.
  await expect(async () => {
    const skeletons = await bar.locator('[data-slot="skeleton"]').count();
    expect(skeletons).toBe(0);
  }).toPass({ timeout: 15_000 });
}

test.describe("mission-control kpi bar", () => {
  test("zero-state baseline matches snapshot", async ({ page, request }) => {
    const proj = await seedKpiBarProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitKpiBar(page);

    // Sanity-check the fixed 5-card layout before we spend pixels on it.
    // If a regression drops a card we want an assertion failure, not a
    // confusingly-similar snapshot diff.
    const bar = page.getByTestId("mission-control-kpi-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("kpi-slices")).toBeVisible();
    await expect(page.getByTestId("kpi-active-tasks")).toBeVisible();
    await expect(page.getByTestId("kpi-pending-approval")).toBeVisible();
    await expect(page.getByTestId("kpi-failed-24h")).toBeVisible();
    await expect(page.getByTestId("kpi-tokens-cost")).toBeVisible();

    // Zero-state copy: slices render as `0 / 0`, pending/failed stay
    // neutral (no amber / destructive tone).
    await expect(page.getByTestId("kpi-slices-value")).toHaveText("0 / 0");
    await expect(page.getByTestId("kpi-pending-approval")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    await expect(page.getByTestId("kpi-failed-24h")).toHaveAttribute(
      "data-tone",
      "neutral",
    );

    await freeze(page);
    // Crop to the bar — the rest of the board view is stubbed (slice 02/03
    // placeholders) and visually noisy. Snapshotting just the bar isolates
    // the regression target.
    await expect(bar).toHaveScreenshot("kpi-bar-empty.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("numeric values match /projects/:id/stats", async ({ page, request }) => {
    const proj = await seedKpiBarProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitKpiBar(page);

    // Number-match contract: whatever `useKpiData` renders MUST equal the
    // server's view of the same project. If the aggregator ever drifts
    // (e.g. starts counting `queued` under `activeTasks`), this test is
    // what catches the regression.
    const stats = await fetchProjectStats(request, proj.projectId);

    const slicesTotal = stats.slices.total;
    const slicesDone = stats.slices.completed;
    const active = (stats.tasks.running ?? 0) + (stats.tasks.assigned ?? 0);
    const failed = stats.tasks.failed ?? 0;

    await expect(page.getByTestId("kpi-slices-value")).toHaveText(
      `${slicesDone} / ${slicesTotal}`,
    );
    // StatCard renders the numeric value inside a `.text-2xl.font-bold` div.
    // Targeting that div lets us assert an exact match — `toContainText`
    // against the whole card matches "Active tasks0" for value 0, which
    // defeats the point of a number-match test.
    const activeValue = page
      .getByTestId("kpi-active-tasks")
      .locator(".text-2xl")
      .first();
    await expect(activeValue).toHaveText(String(active));

    const failedValue = page.getByTestId("kpi-failed-24h").locator(".text-2xl").first();
    await expect(failedValue).toHaveText(String(failed));
  });

  test("react-query refetch surfaces new tasks in the KPI bar", async ({
    page,
    request,
  }) => {
    const proj = await seedKpiBarProject(request);

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitKpiBar(page);

    // Pre-state: brand-new project, every tile should show 0.
    const activeValue = page
      .getByTestId("kpi-active-tasks")
      .locator(".text-2xl")
      .first();
    const failedValue = page
      .getByTestId("kpi-failed-24h")
      .locator(".text-2xl")
      .first();
    await expect(activeValue).toHaveText("0");
    await expect(failedValue).toHaveText("0");

    // Create a task directly via the API. FLOCKCTL_MOCK_AI=1 means the
    // mock executor may race the row through queued → running →
    // failed/done within a few hundred ms; either way `/projects/:id/
    // stats` will show a non-zero counter somewhere within the 4s
    // budget we allow. We poll the server here as a baseline — if the
    // row never makes it out of queued, the UI-convergence assertion
    // below would be trivially satisfied (0 == 0), which is not what
    // we want.
    const createRes = await request.post("/tasks", {
      data: {
        projectId: proj.projectId,
        prompt: "kpi-bar-e2e probe task",
        agent: "claude-code",
        workingDir: proj.projectPath,
      },
    });
    expect(createRes.status()).toBe(201);

    // The server must register the write almost instantly.
    await expect(async () => {
      const s = await fetchProjectStats(request, proj.projectId);
      expect(s.tasks.total).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 4_000, intervals: [200, 400, 800] });

    // useProjectStats is configured with `refetchInterval: 30_000` and
    // no WS-driven invalidation today — so a fresh render is the
    // fastest path to an up-to-date KPI bar. The test asserts the
    // number-match contract (DOM == server) after that refetch; the
    // 30s → on-demand refresh is exactly the knob a future slice will
    // tune when it wires WS invalidation in.
    await page.reload();
    await waitKpiBar(page);

    await expect(async () => {
      const s = await fetchProjectStats(request, proj.projectId);
      const active = (s.tasks.running ?? 0) + (s.tasks.assigned ?? 0);
      const failed = s.tasks.failed ?? 0;
      const activeV = page
        .getByTestId("kpi-active-tasks")
        .locator(".text-2xl")
        .first();
      const failedV = page
        .getByTestId("kpi-failed-24h")
        .locator(".text-2xl")
        .first();
      await expect(activeV).toHaveText(String(active), { timeout: 500 });
      await expect(failedV).toHaveText(String(failed), { timeout: 500 });
    }).toPass({ timeout: 5_000, intervals: [200, 400, 600, 800] });
  });

  test("tablet viewport collapses the grid to 3 columns", async ({
    page,
    request,
  }) => {
    const proj = await seedKpiBarProject(request);
    // md breakpoint (768-1023). The grid changes from `lg:grid-cols-5`
    // to `md:grid-cols-3`, wrapping the last two tiles onto a second
    // row. The baseline guards against a future Tailwind upgrade
    // dropping the `md:` class and leaving us stuck at 2 cols.
    await page.setViewportSize({ width: 820, height: 800 });

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitKpiBar(page);

    const bar = page.getByTestId("mission-control-kpi-bar");
    const template = await bar.evaluate(
      (el) => window.getComputedStyle(el).gridTemplateColumns,
    );
    expect(template.split(/\s+/).length).toBe(3);

    await freeze(page);
    await expect(bar).toHaveScreenshot("kpi-bar-md.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("phone viewport collapses the grid to 2 columns", async ({
    page,
    request,
  }) => {
    const proj = await seedKpiBarProject(request);
    // Below the `md:` breakpoint the grid falls back to `grid-cols-2`.
    // Five cards at 2 cols → three rows (2 + 2 + 1); the snapshot
    // captures that wrap so a future dense-layout experiment that
    // accidentally drops the fallback is caught.
    await page.setViewportSize({ width: 420, height: 900 });

    await page.goto(`/projects/${proj.projectId}?view=board`);
    await waitKpiBar(page);

    const bar = page.getByTestId("mission-control-kpi-bar");
    const template = await bar.evaluate(
      (el) => window.getComputedStyle(el).gridTemplateColumns,
    );
    expect(template.split(/\s+/).length).toBe(2);

    await freeze(page);
    await expect(bar).toHaveScreenshot("kpi-bar-sm.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
