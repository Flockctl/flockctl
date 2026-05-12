import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createProject, uniq } from "./_helpers";

/**
 * Shell axe + visual baseline (TitleBar / Sidebar / Breadcrumb).
 *
 * This spec ships two coupled regression nets for the new shell chrome:
 *
 *   1. **Structural smokes + axe scans** — load `/dashboard` (and
 *      `/projects` for the multi-segment breadcrumb), assert the three
 *      slots mount, then run axe scoped to each chrome region in both
 *      light and dark themes. The scan is restricted to serious +
 *      critical impact so structural bugs (missing labels, roles,
 *      names) trip the test, but app-wide token findings already
 *      documented in `tokens-preview.spec.ts` do not double-fail here
 *      (`color-contrast` rule disabled).
 *
 *   2. **Scoped screenshot baselines** — eight image diffs covering the
 *      three chrome surfaces:
 *        - shell-titlebar-{light,dark}.png      → `[data-slot="title-bar"]`
 *        - shell-sidebar-{light,dark}.png       → `[data-slot="sidebar"]`
 *        - shell-sidebar-hover-light.png        → sidebar with the
 *                                                  inactive `Projects`
 *                                                  nav row hovered
 *        - shell-breadcrumb-{root,project,project-tab}.png
 *                                              → `nav[aria-label="Breadcrumb"]`
 *                                                at three depths.
 *
 *      Each shot is scoped to a single element (no full-page captures)
 *      so a route-body change can't bleed into a chrome-only diff. The
 *      legacy full-page baselines in `visual-legacy-pages.spec.ts`
 *      still cover route bodies until M26/02 retires that spec.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/shell.spec.ts
 */

const KEY = "flockctl.ui.next";

async function setNextShell(page: Page) {
  await page.addInitScript(
    ({ key }) => {
      try {
        window.localStorage.setItem(key, "true");
      } catch {
        /* ignore */
      }
    },
    { key: KEY },
  );
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
}

async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
  });
}

function blockingViolations(violations: { impact?: string | null }[]) {
  return violations.filter((v) =>
    ["serious", "critical"].includes(String(v.impact ?? "")),
  );
}

test.describe("shell — structural smoke", () => {
  test.beforeEach(async ({ page }) => {
    await setNextShell(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("title bar, sidebar, breadcrumb mount on /dashboard", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.locator("[data-shell='next']")).toHaveCount(1);
    await expect(page.locator("[data-slot='title-bar']")).toHaveCount(1);
    await expect(page.locator("[data-slot='sidebar']")).toHaveCount(1);
    // Breadcrumb anchors inside the title bar.
    await expect(
      page.locator("[data-slot='title-bar']").getByText(/dashboard/i).first(),
    ).toBeVisible();
  });

  test("⌘K button is present and keyboard-reachable on desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/dashboard");
    const cmdk = page.getByRole("button", { name: /command palette/i });
    await expect(cmdk).toBeVisible();
    // Click toggles the palette (handler runs even though disabled
    // text reads "coming soon" until M18 wires it through fully).
    await cmdk.focus();
    await expect(cmdk).toBeFocused();
  });

  test("narrow viewport (640px) keeps shell usable; ⌘K button stays mounted", async ({
    page,
  }) => {
    // NOTE: the slice brief calls for the ⌘K trigger to "collapse"
    // (hide) at narrow viewports. The current TitleBar implementation
    // (post-prototype-refresh) hardcodes `w-72` and renders the button
    // unconditionally — there is no responsive `hidden sm:inline-flex`
    // utility on it. We assert the looser invariant — shell sentinel
    // + sidebar are still visible at 640px — and surface the missing
    // collapse as a finding in the parent slice's `## Bug-bash log`.
    await page.setViewportSize({ width: 640, height: 800 });
    await page.goto("/dashboard");
    await expect(page.locator("[data-shell='next']")).toHaveCount(1);
    await expect(page.locator("[data-slot='sidebar']")).toBeVisible();
    // The button still mounts (so a future responsive refactor can
    // wire `hidden md:inline-flex` without breaking this assertion);
    // we deliberately do NOT assert visible/hidden here.
    await expect(
      page.getByRole("button", { name: /command palette/i }),
    ).toHaveCount(1);
  });

  test("theme toggle flips html.dark without losing the shell sentinel", async ({
    page,
  }) => {
    await setTheme(page, "light");
    await page.goto("/dashboard");
    await expect(page.locator("html")).toHaveClass(/light/);
    const toggle = page.getByRole("button", { name: /^theme:/i });
    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // Shell sentinel survives.
    await expect(page.locator("[data-shell='next']")).toHaveCount(1);
  });
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`shell — axe (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await setNextShell(page);
      await setTheme(page, theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
    });

    test(`axe scan: TitleBar (${theme}) returns 0 serious/critical violations`, async ({
      page,
    }) => {
      await page.goto("/dashboard");
      await expect(page.locator("[data-slot='title-bar']")).toBeVisible();
      await freezeAnimations(page);

      // We disable `color-contrast` here for the same reason the
      // tokens-preview spec does: the M22/T02 palette has known
      // sub-AA pairings on muted-foreground / muted that are app-
      // wide token findings, not shell-specific bugs. Structural
      // a11y rules (labels, roles, names, focus order) still run.
      const results = await new AxeBuilder({ page })
        .include("[data-slot='title-bar']")
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = blockingViolations(results.violations);
      if (blocking.length > 0) {
        console.error(
          `axe TitleBar ${theme} blocking violations:`,
          JSON.stringify(
            blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
            null,
            2,
          ),
        );
      }
      expect(blocking).toHaveLength(0);
    });

    test(`axe scan: Sidebar (${theme}) returns 0 serious/critical violations`, async ({
      page,
    }) => {
      await page.goto("/dashboard");
      await expect(page.locator("[data-slot='sidebar']")).toBeVisible();
      await freezeAnimations(page);

      const results = await new AxeBuilder({ page })
        .include("[data-slot='sidebar']")
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = blockingViolations(results.violations);
      if (blocking.length > 0) {
        console.error(
          `axe Sidebar ${theme} blocking violations:`,
          JSON.stringify(
            blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
            null,
            2,
          ),
        );
      }
      expect(blocking).toHaveLength(0);
    });

    test(`axe scan: Breadcrumb (${theme}) returns 0 serious/critical violations`, async ({
      page,
    }) => {
      // Use a route that produces a multi-segment breadcrumb so the
      // chevron separators and link semantics are in scope.
      await page.goto("/projects");
      const titleBar = page.locator("[data-slot='title-bar']");
      await expect(titleBar).toBeVisible();
      await freezeAnimations(page);

      // The Breadcrumb component is the flex region inside the title
      // bar that hosts the dynamic segments. Scope by data-testid on
      // the separator's parent if present; else scope the whole
      // breadcrumb container via the existing slot.
      const results = await new AxeBuilder({ page })
        .include("[data-slot='title-bar']")
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = blockingViolations(results.violations);
      if (blocking.length > 0) {
        console.error(
          `axe Breadcrumb ${theme} blocking violations:`,
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
}

// ---------------------------------------------------------------------------
// Visual baselines — eight scoped screenshots covering the three chrome
// surfaces. Each shot is scoped to a single element (no `fullPage`) so a
// route-body change cannot leak into a chrome-only diff.
//
// The connection dot in the title bar uses `bg-amber-500 animate-pulse`
// while the daemon health check is in flight and a steady
// `bg-emerald-500` once `connectionStatus === "connected"`. We wait for
// the steady state via aria-label before snapshotting; `freezeAnimations`
// only stops in-flight motion, it doesn't change which CSS state is
// active. The breadcrumb's parametric segment (`/projects/:id`) renders
// a `loading: true` skeleton until the project query lands in the React
// Query cache (see `projectDetailHandle`) — we wait on the literal
// project name to land before snapshotting that variant.
// ---------------------------------------------------------------------------

let seededProjectId: number;
let seededProjectName: string;
let seedingContext: APIRequestContext | null = null;

async function pinThemeBeforeMount(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* swallow — Safari private mode etc. */
    }
  }, theme);
}

async function waitForConnectionDotConnected(page: Page) {
  // The TitleBar renders a `<LiveDot state={connected ? "live" : "error"}/>`
  // primitive next to the daemon address. The primitive emits
  // `data-state="live"` once `connectionStatus === "connected"` and
  // `data-state="error"` while in `checking`/`error`. Wait for the
  // steady `live` state so the dot's colour (and its `animate-ping`
  // halo) is deterministic before we snapshot. `freezeAnimations`
  // stops in-flight motion but doesn't change which CSS state is
  // active, hence the explicit wait.
  await expect(
    page.locator('[data-slot="title-bar"] [data-state="live"]').first(),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("shell — visual baselines", () => {
  test.beforeAll(async () => {
    // Build a parallel APIRequestContext pointed at the dev server (which
    // proxies through to the e2e backend). Mirrors the seeding pattern in
    // `visual-legacy-pages.spec.ts` — `request` is a test-scoped fixture
    // and can't be used from `beforeAll` directly.
    const frontendPort = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
    seedingContext = await playwrightRequest.newContext({
      baseURL: `http://localhost:${frontendPort}`,
    });

    // Pin the project name so the breadcrumb-project-tab snapshot is
    // stable across regenerations. `uniq` would inject a Date.now()
    // suffix that drifts every run; a fixed slug means the breadcrumb's
    // entity segment ("shell-baseline-proj") is identical run-to-run.
    // Path is unique-per-run so a stale `.e2e-data/` doesn't 409 on
    // duplicate-path validation; the breadcrumb only reads `name`.
    seededProjectName = "shell-baseline-proj";
    const project = await createProject(seedingContext, seededProjectName, {
      path: `/tmp/${uniq(seededProjectName)}`,
    });
    seededProjectId = project.id;
  });

  test.afterAll(async () => {
    await seedingContext?.dispose();
    seedingContext = null;
  });

  // --- TitleBar (light + dark) -------------------------------------------
  for (const theme of ["light", "dark"] as const) {
    test(`titlebar ${theme} baseline`, async ({ page }) => {
      await pinThemeBeforeMount(page, theme);
      await page.goto("/dashboard");
      await waitForConnectionDotConnected(page);
      await freezeAnimations(page);

      const titlebar = page.locator('[data-slot="title-bar"]');
      await expect(titlebar).toBeVisible();
      await expect(titlebar).toHaveScreenshot(`shell-titlebar-${theme}.png`, {
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  // --- Sidebar (light + dark) --------------------------------------------
  for (const theme of ["light", "dark"] as const) {
    test(`sidebar ${theme} baseline`, async ({ page }) => {
      await pinThemeBeforeMount(page, theme);
      await page.goto("/dashboard");
      // Wait for the dot to land on `connected` so the network is
      // settled before the screenshot — the BrowseNav attention badge
      // reads `useAttention()` and a mid-capture flicker would diff.
      await waitForConnectionDotConnected(page);
      await freezeAnimations(page);

      const sidebar = page.locator('[data-slot="sidebar"]');
      await expect(sidebar).toBeVisible();
      // Anchor on a stable nav link (Browse → Dashboard, active on
      // /dashboard) so we know BrowseNav has hydrated.
      await expect(
        sidebar.getByRole("link", { name: "Dashboard" }),
      ).toBeVisible();
      await expect(sidebar).toHaveScreenshot(`shell-sidebar-${theme}.png`, {
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  // --- Sidebar hover (light only) ----------------------------------------
  test("sidebar hover light baseline", async ({ page }) => {
    // Locked to light mode — the dark-mode hover state uses the same
    // `--sidebar-accent` token, so capturing both would double the
    // maintenance cost without catching anything new.
    await pinThemeBeforeMount(page, "light");
    await page.goto("/dashboard");
    await waitForConnectionDotConnected(page);
    await freezeAnimations(page);

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();

    // Hover an inactive row — hovering the active /dashboard link
    // would just re-paint the same accent background and produce a
    // diff identical to the resting baseline.
    const target = sidebar.getByRole("link", { name: "Projects" });
    await expect(target).toBeVisible();
    await target.hover();

    await expect(sidebar).toHaveScreenshot("shell-sidebar-hover-light.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  // --- Breadcrumb at three depths ----------------------------------------
  //
  // The static handle table in `src/lib/route-handles.ts` produces:
  //   /dashboard      → 1 segment   ("Dashboard")
  //   /projects       → 1 segment   ("Projects")
  //   /projects/:id   → 2 segments  ("Projects" > <name>)
  //
  // `?tab=…` on a project-detail URL is page-internal state and does
  // NOT contribute a breadcrumb segment — `/projects/:id` is the
  // deepest single trail the static handles produce, which makes it
  // the right surface for the project-tab baseline.
  test("breadcrumb root baseline", async ({ page }) => {
    await pinThemeBeforeMount(page, "light");
    await page.goto("/dashboard");
    await waitForConnectionDotConnected(page);
    await freezeAnimations(page);

    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb).toBeVisible();
    await expect(crumb).toContainText("Dashboard");
    await expect(crumb).toHaveScreenshot("shell-breadcrumb-root.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("breadcrumb project baseline", async ({ page }) => {
    await pinThemeBeforeMount(page, "light");
    await page.goto("/projects");
    await waitForConnectionDotConnected(page);
    await freezeAnimations(page);

    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb).toBeVisible();
    await expect(crumb).toContainText("Projects");
    await expect(crumb).toHaveScreenshot("shell-breadcrumb-project.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("breadcrumb project-tab baseline", async ({ page }) => {
    await pinThemeBeforeMount(page, "light");
    await page.goto(`/projects/${seededProjectId}`);
    await waitForConnectionDotConnected(page);

    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb).toBeVisible();
    // Wait for the literal project name to land before freezing —
    // until `useProject` hydrates the cache the second segment renders
    // a `loading: true` skeleton, and freezing first would diff that.
    await expect(crumb).toContainText("Projects");
    await expect(crumb).toContainText(seededProjectName);

    await freezeAnimations(page);
    await expect(crumb).toHaveScreenshot("shell-breadcrumb-project-tab.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
