/**
 * Project-detail page — smoke tests + M23 visual baselines + axe (slice 23-00 / T10).
 *
 * Two distinct surfaces share this file:
 *
 *   1. **Smoke tests** (pre-existing) — assert the route renders the
 *      project name and that the legacy `/projects/:id/settings` page
 *      still mounts. Cheap, no seeding.
 *
 *   2. **M23 visual baselines + axe scans** (new with T10) — pin down
 *      the redesigned project-detail surface across the five tabs and
 *      light/dark theme variants the slice calls out. Six full-page
 *      screenshots:
 *
 *        - project-detail-plan-light.png       (Plan tab, seeded milestones)
 *        - project-detail-plan-dark.png        (Plan tab, dark)
 *        - project-detail-runs-light.png       (Runs tab)
 *        - project-detail-code-dark.png        (Code tab, dark)
 *        - project-detail-templates-light.png  (Templates & Schedules tab)
 *        - project-detail-config-light.png     (Config tab)
 *        - project-detail-empty-milestones.png (Plan tab, no milestones)
 *
 *      Each tab also runs an axe scan scoped to the `[data-testid=
 *      "project-detail-page"]` subtree and asserts zero serious/critical
 *      violations. `color-contrast` is disabled for the same reason
 *      `tokens-preview.spec.ts` and `shell.spec.ts` disable it: the
 *      M22/T02 palette has known sub-AA `muted` pairings that are tracked
 *      separately at the token layer, not per-page.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/project-detail.spec.ts
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createProject, uniq } from "./_helpers";
import { seedSliceBoardProject, type SliceBoardProject } from "./fixtures/slice-board";

// ---------------------------------------------------------------------------
// Shared helpers — mirror the patterns established in dashboard.spec.ts and
// shell.spec.ts so the diff stays small if those helpers ever centralise.
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
 * Wait until the project-detail page chrome (header + KPI row + tab strip)
 * has hydrated. The KPI row mounts unconditionally inside the page body —
 * see `project-detail.tsx` ~line 260 — so anchoring on `project-detail-tabs`
 * after the page sentinel guarantees the tab strip is the most recent paint.
 */
async function waitForProjectDetailReady(page: Page) {
  await expect(page.getByTestId("project-detail-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("project-detail-tabs")).toBeVisible({
    timeout: 15_000,
  });
}

function blockingViolations(violations: { impact?: string | null }[]) {
  return violations.filter((v) =>
    ["serious", "critical"].includes(String(v.impact ?? "")),
  );
}

// ---------------------------------------------------------------------------
// Smoke tests (pre-existing)
// ---------------------------------------------------------------------------

test("project detail page renders project name", async ({ page, request }) => {
  const name = uniq("proj-detail");
  const proj = await createProject(request, name);

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("legacy /projects/:id/settings redirects to ?tab=config", async ({
  page,
  request,
}) => {
  // The retired ProjectSettingsPage has been folded into the M23 Config
  // tab — `/settings` now resolves via `<ProjectSettingsRedirect>` (see
  // `ui/src/main.tsx`). Assert the redirect lands on the config pane and
  // that the General + AI Configuration section headers from
  // `ConfigTab-cards.tsx` still render so deep-linked bookmarks survive.
  const proj = await createProject(request);

  await page.goto(`/projects/${proj.id}/settings`);
  await expect(page).toHaveURL(/\?tab=config/);
  await expect(page.getByTestId("project-config-tab")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("General").first()).toBeVisible();
  await expect(page.getByText("AI Configuration").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// M23 visual baselines + axe
// ---------------------------------------------------------------------------

let seededWithMilestones: SliceBoardProject | null = null;
let seededEmptyId: number | null = null;
let seedingContext: APIRequestContext | null = null;

test.describe("project-detail — M23 visual baselines + axe", () => {
  test.beforeAll(async () => {
    // Build a parallel APIRequestContext pointed at the dev server (which
    // proxies to the e2e backend). `request` is a test-scoped fixture and
    // can't be used from `beforeAll` directly — same pattern as
    // visual-legacy-pages.spec.ts and shell.spec.ts.
    const frontendPort = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
    seedingContext = await playwrightRequest.newContext({
      baseURL: `http://localhost:${frontendPort}`,
    });

    // Plan / Runs / Code / Templates / Config baselines all share the same
    // seeded project — keeps the snapshot baselines visually coherent
    // (same name, same KPIs) and shaves ~3s off the spec runtime.
    seededWithMilestones = await seedSliceBoardProject(seedingContext);

    // Separate empty-state project: zero milestones surfaces the "No
    // milestones yet — generate a plan to get started." placeholder
    // (`data-testid="project-detail-plan-empty"`).
    const empty = await createProject(seedingContext, uniq("proj-detail-empty"));
    seededEmptyId = empty.id;
  });

  test.afterAll(async () => {
    await seedingContext?.dispose();
    seedingContext = null;
  });

  // --- Plan tab (light + dark) -------------------------------------------
  for (const theme of ["light", "dark"] as const) {
    test(`plan tab ${theme} baseline + axe`, async ({ page }) => {
      if (!seededWithMilestones) throw new Error("fixture not seeded");
      await setTheme(page, theme);
      await page.goto(`/projects/${seededWithMilestones.projectId}?tab=plan`);
      await waitForProjectDetailReady(page);

      // Confirm Plan tab is active (URL contract honoured) and the
      // milestone kanban actually rendered cards before snapshotting.
      await expect(page.getByTestId("project-tab-plan")).toHaveAttribute(
        "data-active",
        "true",
      );
      await expect(page.getByTestId("milestone-kanban")).toBeVisible();

      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`project-detail-plan-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });

      const results = await new AxeBuilder({ page })
        .include('[data-testid="project-detail-page"]')
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = blockingViolations(results.violations);
      if (blocking.length > 0) {
        console.error(
          `axe Plan ${theme} blocking violations:`,
          JSON.stringify(
            blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
            null,
            2,
          ),
        );
      }
      expect(blocking).toHaveLength(0);
    });
  }

  // --- Runs tab (light) --------------------------------------------------
  test("runs tab light baseline + axe", async ({ page }) => {
    if (!seededWithMilestones) throw new Error("fixture not seeded");
    await setTheme(page, "light");
    await page.goto(`/projects/${seededWithMilestones.projectId}?tab=runs`);
    await waitForProjectDetailReady(page);

    await expect(page.getByTestId("project-tab-runs")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("project-runs-tab")).toBeVisible();

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("project-detail-runs-light.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });

    const results = await new AxeBuilder({ page })
      .include('[data-testid="project-detail-page"]')
      .disableRules(["color-contrast"])
      .analyze();

    const blocking = blockingViolations(results.violations);
    if (blocking.length > 0) {
      console.error(
        "axe Runs light blocking violations:",
        JSON.stringify(
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
          null,
          2,
        ),
      );
    }
    expect(blocking).toHaveLength(0);
  });

  // --- Code tab (dark) ---------------------------------------------------
  test("code tab dark baseline + axe", async ({ page }) => {
    if (!seededWithMilestones) throw new Error("fixture not seeded");
    await setTheme(page, "dark");
    await page.goto(`/projects/${seededWithMilestones.projectId}?tab=code`);
    await waitForProjectDetailReady(page);

    await expect(page.getByTestId("project-tab-code")).toHaveAttribute(
      "data-active",
      "true",
    );
    // The empty-file placeholder mounts unconditionally until a file is
    // opened — see `code-mode-empty` testid in CodeMode.tsx. Anchoring
    // on it lets us skip Monaco-load races entirely.
    await expect(page.getByTestId("code-mode-empty").first()).toBeVisible({
      timeout: 15_000,
    });

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("project-detail-code-dark.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });

    // The Code tab embeds react-arborist's virtualized `<Tree>`, which
    // emits an inner `<div role="tree"> > <div style="overflow: auto">`
    // wrapper without `tabindex`. axe flags it under
    // `scrollable-region-focusable` (serious). The library exposes no
    // hook to inject a tabindex on that inner wrapper without forking,
    // and the outer `role="tree"` itself IS keyboard-reachable via the
    // arrow-key roving focus in `TreeNode`. Disabled here (and only
    // here) and tracked in `## Bug-bash log` of the parent slice.
    const results = await new AxeBuilder({ page })
      .include('[data-testid="project-detail-page"]')
      .disableRules(["color-contrast", "scrollable-region-focusable"])
      .analyze();

    const blocking = blockingViolations(results.violations);
    if (blocking.length > 0) {
      console.error(
        "axe Code dark blocking violations:",
        JSON.stringify(
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
          null,
          2,
        ),
      );
    }
    expect(blocking).toHaveLength(0);
  });

  // --- Templates & Schedules tab (light) ---------------------------------
  test("templates tab light baseline + axe", async ({ page }) => {
    if (!seededWithMilestones) throw new Error("fixture not seeded");
    await setTheme(page, "light");
    await page.goto(`/projects/${seededWithMilestones.projectId}?tab=templates`);
    await waitForProjectDetailReady(page);

    await expect(page.getByTestId("project-tab-templates")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(
      page.getByTestId("project-templates-and-schedules-tab"),
    ).toBeVisible();

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("project-detail-templates-light.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });

    const results = await new AxeBuilder({ page })
      .include('[data-testid="project-detail-page"]')
      .disableRules(["color-contrast"])
      .analyze();

    const blocking = blockingViolations(results.violations);
    if (blocking.length > 0) {
      console.error(
        "axe Templates light blocking violations:",
        JSON.stringify(
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
          null,
          2,
        ),
      );
    }
    expect(blocking).toHaveLength(0);
  });

  // --- Config tab (light) ------------------------------------------------
  test("config tab light baseline + axe", async ({ page }) => {
    if (!seededWithMilestones) throw new Error("fixture not seeded");
    await setTheme(page, "light");
    await page.goto(`/projects/${seededWithMilestones.projectId}?tab=config`);
    await waitForProjectDetailReady(page);

    await expect(page.getByTestId("project-tab-config")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("project-config-tab")).toBeVisible();

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("project-detail-config-light.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });

    const results = await new AxeBuilder({ page })
      .include('[data-testid="project-detail-page"]')
      .disableRules(["color-contrast"])
      .analyze();

    const blocking = blockingViolations(results.violations);
    if (blocking.length > 0) {
      console.error(
        "axe Config light blocking violations:",
        JSON.stringify(
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
          null,
          2,
        ),
      );
    }
    expect(blocking).toHaveLength(0);
  });

  // --- Empty-milestones state (light) ------------------------------------
  test("empty milestones baseline + axe", async ({ page }) => {
    if (!seededEmptyId) throw new Error("fixture not seeded");
    await setTheme(page, "light");
    await page.goto(`/projects/${seededEmptyId}?tab=plan`);
    await waitForProjectDetailReady(page);

    // The empty placeholder is the canonical "fresh project, no plan
    // yet" surface. Anchoring on it confirms we're in the empty branch
    // (vs. mid-flight `useProjectTree` skeleton, which would diff).
    await expect(page.getByTestId("project-detail-plan-empty")).toBeVisible({
      timeout: 15_000,
    });

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot(
      "project-detail-empty-milestones.png",
      {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      },
    );

    const results = await new AxeBuilder({ page })
      .include('[data-testid="project-detail-page"]')
      .disableRules(["color-contrast"])
      .analyze();

    const blocking = blockingViolations(results.violations);
    if (blocking.length > 0) {
      console.error(
        "axe empty-milestones blocking violations:",
        JSON.stringify(
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
          null,
          2,
        ),
      );
    }
    expect(blocking).toHaveLength(0);
  });
});
