/**
 * Analytics page — structural smokes + visual baselines (slice 25-02 / T04).
 *
 * The analytics page is a redesigned data-heavy library surface
 * (`/analytics`). This spec ships:
 *
 *   1. **Structural smokes** — landmarks render, the page header /
 *      KPI strip / charts grid / by-project table all mount, and the
 *      `?range=` query string drives the data fetch.
 *
 *   2. **Visual baselines** — six full-page screenshots covering:
 *        - analytics-default-{light,dark}.png  (no `?range=`, so 7d default)
 *        - analytics-7d-{light,dark}.png       (explicit `?range=7d`)
 *        - analytics-empty-{light,dark}.png    (data fetch served, no rows)
 *
 *      Each shot freezes animations and pins theme via localStorage
 *      before the first paint, mirroring the helper pattern in
 *      `dashboard.spec.ts` and `shell.spec.ts`.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/analytics.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* swallow — Safari private mode etc. */
    }
  }, theme);
}

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

/**
 * Wait for the analytics page's structural sentinels to mount before
 * snapshotting. The KPI row depends on `useMetricsOverview`; the
 * by-project card waits on a second hook (`useUsageBreakdown`). We
 * anchor on both so the assertion fires only after both fetches have
 * settled.
 */
async function waitForAnalyticsReady(page: Page) {
  await expect(page.getByTestId("analytics-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("analytics-kpi-row")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("analytics-by-project-card")).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Structural smokes — preserve the legacy probes the page used to ship.
// ---------------------------------------------------------------------------

test("analytics page loads and calls /metrics on render", async ({ page }) => {
  const metricsRequested = page.waitForResponse(
    (r) => r.url().includes("/metrics") && r.request().method() === "GET",
  );
  await page.goto("/analytics");
  await expect(
    page.getByRole("heading", { name: "Analytics", level: 1 }),
  ).toBeVisible();
  const res = await metricsRequested;
  expect(res.status()).toBe(200);
});

test("analytics page renders SectionHeader, KPI row, charts grid, and by-project table", async ({
  page,
}) => {
  await page.goto("/analytics");
  await waitForAnalyticsReady(page);

  // SectionHeader landmark — the h1 is the page title.
  await expect(
    page.getByRole("heading", { name: "Analytics", level: 1 }),
  ).toBeVisible();

  // RangeFilter renders inside the header action slot.
  await expect(page.getByTestId("analytics-range-filter")).toBeVisible();

  // KPI strip — four tiles per the T01 contract.
  await expect(page.getByTestId("kpi-tile")).toHaveCount(4);

  // Charts grid + occupants.
  await expect(page.getByTestId("analytics-charts-grid")).toBeVisible();
  await expect(
    page.getByTestId("analytics-spend-chart-card"),
  ).toBeVisible();
  await expect(
    page.getByTestId("analytics-token-chart-card"),
  ).toBeVisible();

  // By-project rollup.
  await expect(page.getByTestId("analytics-by-project-card")).toBeVisible();
});

test("RangeFilter writes ?range= to the URL and re-fires /metrics", async ({
  page,
}) => {
  await page.goto("/analytics");
  await waitForAnalyticsReady(page);

  // Switch to 30d — the segmented toggle's options are radios.
  const filter = page.getByTestId("analytics-range-filter");
  const option30d = filter.getByRole("radio", { name: "30d" });
  const metricsRefetched = page.waitForResponse(
    (r) =>
      r.url().includes("/metrics") &&
      r.request().method() === "GET" &&
      r.url().includes("period=30d"),
  );
  await option30d.click();
  await expect(page).toHaveURL(/[?&]range=30d/);
  const res = await metricsRefetched;
  expect(res.status()).toBe(200);
});

// ---------------------------------------------------------------------------
// Visual baselines — default / 7d / empty × light / dark.
// ---------------------------------------------------------------------------

test.describe("analytics — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`analytics-default-${theme} baseline (no ?range=, 7d default)`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.goto("/analytics");
      await waitForAnalyticsReady(page);
      await freezeAnimations(page);

      // The default branch is `7d` — pin the expectation so a regression
      // in the validator silently flipping the default is caught here.
      await expect(
        page
          .getByTestId("analytics-range-filter")
          .getByRole("radio", { name: "7d" }),
      ).toHaveAttribute("aria-checked", "true");

      await expect(page).toHaveScreenshot(
        `analytics-default-${theme}.png`,
        {
          fullPage: true,
          threshold: 0.1,
          maxDiffPixelRatio: 0.02,
        },
      );
    });

    test(`analytics-7d-${theme} baseline (explicit ?range=7d)`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.goto("/analytics?range=7d");
      await waitForAnalyticsReady(page);
      await freezeAnimations(page);

      await expect(
        page
          .getByTestId("analytics-range-filter")
          .getByRole("radio", { name: "7d" }),
      ).toHaveAttribute("aria-checked", "true");

      await expect(page).toHaveScreenshot(`analytics-7d-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`analytics-empty-${theme} baseline (no project / cost rows)`, async ({
      page,
    }) => {
      // Stub the data hooks at the network boundary so the page renders
      // its empty-state branches deterministically. Three concerns:
      //   - /metrics returns zeroed totals + empty daily_costs
      //   - /usage breakdown returns no items
      //   - /tasks returns an empty page (so the project aggregator has
      //     nothing to feed the table even if the breakdown ever did)
      await page.route(/\/metrics(\?|$)/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            time: {
              total_work_seconds: 0,
              avg_duration_seconds: null,
              median_duration_seconds: null,
              avg_queue_wait_seconds: null,
              peak_hours: [],
            },
            productivity: {
              tasks_by_status: {},
              success_rate: null,
              retry_rate: null,
              tasks_with_code_changes: 0,
              code_change_rate: null,
              avg_tasks_per_day: null,
              tasks_per_day: [],
            },
            cost: {
              total_cost_usd: 0,
              total_input_tokens: 0,
              total_output_tokens: 0,
              total_cache_creation: 0,
              total_cache_read: 0,
              cache_hit_rate: null,
              avg_cost_per_task: null,
              cost_by_outcome: [],
              burn_rate_per_day: null,
              daily_costs: [],
            },
            chats: {
              total_chats: 0,
              avg_messages_per_chat: null,
              avg_chat_duration_seconds: null,
              total_chat_time_seconds: 0,
            },
            schedules: { total: 0, active: 0, paused: 0 },
          }),
        });
      });
      await page.route(/\/usage\/breakdown(\?|$)/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost_usd: 0,
            total_record_count: 0,
            items: [],
          }),
        });
      });
      await page.route(/\/tasks\?/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 200 }),
        });
      });

      await setTheme(page, theme);
      await page.goto("/analytics");
      await waitForAnalyticsReady(page);

      // Confirm we're in the empty branch — both empty-state placeholders
      // mount when the data hooks return zeroes/no rows.
      await expect(
        page.getByTestId("analytics-spend-chart-empty"),
      ).toBeVisible();
      await expect(
        page.getByTestId("analytics-by-project-empty"),
      ).toBeVisible();

      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`analytics-empty-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
