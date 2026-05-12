/**
 * Dashboard page — structural smokes + visual baselines (slice 23-01 / T06).
 *
 * The dashboard is the front-door page (route `/`, redirects to
 * `/dashboard`). This spec ships:
 *
 *   1. **Structural smokes** — landmarks render, the header / KPI strip
 *      / RecentActivity / ActiveMissionCard / QuickLinks / TimeRangeSelect
 *      all mount, the New chat button routes to `/chats`, and `/`
 *      redirects to `/dashboard`.
 *
 *   2. **Visual baselines** — six full-page screenshots covering the
 *      time-range × theme matrix:
 *        - dashboard-24h-{light,dark}.png
 *        - dashboard-7d-{light,dark}.png
 *        - dashboard-30d-{light,dark}.png
 *      plus a seventh empty-state baseline (`dashboard-empty-light.png`)
 *      captured from a clean `?range=24h` view with no seeded data.
 *
 *      Each shot freezes animations and pins theme via localStorage
 *      before the first paint, mirroring the helper pattern in
 *      `visual-legacy-pages.spec.ts` and `shell.spec.ts`.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/dashboard.spec.ts
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
 * Wait for the dashboard's structural sentinels to mount before
 * snapshotting. The KPI strip is the latest-arriving block (it depends
 * on `useUsageSummary`), so anchoring on it guarantees the rest of the
 * page has already settled.
 */
async function waitForDashboardReady(page: Page) {
  await expect(page.getByTestId("dashboard-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("dashboard-kpi-tiles")).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Structural smokes
// ---------------------------------------------------------------------------

test.describe("dashboard — structural smokes", () => {
  test("root path redirects to /dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("page chrome mounts with the redesigned header + KPI strip", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await waitForDashboardReady(page);

    // SectionHeader landmark — the h1 is the page title.
    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();

    // Action slot: TimeRangeSelect + New chat button.
    await expect(page.getByTestId("time-range-select")).toBeVisible();
    await expect(
      page.getByTestId("dashboard-new-chat-button"),
    ).toBeVisible();

    // KPI strip — five tiles per the T01 contract.
    await expect(page.getByTestId("kpi-tile")).toHaveCount(5);

    // 3-column grid + occupants.
    await expect(page.getByTestId("dashboard-grid")).toBeVisible();
    await expect(page.getByTestId("recent-activity-header")).toBeVisible();
    await expect(page.getByTestId("active-mission-card")).toBeVisible();
    await expect(page.getByTestId("quick-links-header")).toBeVisible();
  });

  test("New chat button navigates to /chats", async ({ page }) => {
    await page.goto("/dashboard");
    await waitForDashboardReady(page);

    await page.getByTestId("dashboard-new-chat-button").click();
    await expect(page).toHaveURL(/\/chats$/);
  });

  test("TimeRangeSelect writes ?range= to the URL", async ({ page }) => {
    await page.goto("/dashboard");
    await waitForDashboardReady(page);

    const select = page.getByTestId("time-range-select");
    await select.selectOption("7d");
    await expect(page).toHaveURL(/[?&]range=7d/);

    await select.selectOption("30d");
    await expect(page).toHaveURL(/[?&]range=30d/);
  });
});

// ---------------------------------------------------------------------------
// Visual baselines — time-range × theme matrix
// ---------------------------------------------------------------------------

const RANGE_VALUES = ["24h", "7d", "30d"] as const;

test.describe("dashboard — visual baselines", () => {
  for (const range of RANGE_VALUES) {
    for (const theme of ["light", "dark"] as const) {
      test(`dashboard-${range}-${theme} baseline`, async ({ page }) => {
        await setTheme(page, theme);
        await page.goto(`/dashboard?range=${range}`);
        await waitForDashboardReady(page);
        await freezeAnimations(page);

        // Anchor on the picker reflecting the URL — the assertion guards
        // against a regression where the picker drifts from the URL.
        await expect(page.getByTestId("time-range-select")).toHaveValue(
          range,
        );

        await expect(page).toHaveScreenshot(
          `dashboard-${range}-${theme}.png`,
          {
            fullPage: true,
            threshold: 0.1,
            maxDiffPixelRatio: 0.02,
          },
        );
      });
    }
  }

  test("dashboard-empty-light baseline (no seeded data, 24h view)", async ({
    page,
  }) => {
    // The empty-state baseline pins down the canonical "fresh install"
    // shape: zero-tile values, "No recent activity" placeholder, the
    // ActiveMissionCard's empty pitch, and QuickLinks with the
    // attention row reading `0 items need attention`.
    //
    // We pin to light theme — the dark variant is covered by the
    // `dashboard-24h-dark.png` matrix entry. Keeping a single empty-
    // state baseline avoids doubling the screenshot maintenance cost
    // for what is structurally the same content tree.
    await setTheme(page, "light");
    await page.goto("/dashboard?range=24h");
    await waitForDashboardReady(page);

    // Confirm we're in the empty branch — `data-state="empty"` on the
    // ActiveMissionCard fires when no mission is in flight, which is
    // the canonical empty-state assertion.
    await expect(
      page.getByTestId("active-mission-card"),
    ).toHaveAttribute("data-state", "empty");

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("dashboard-empty-light.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
