/**
 * Legacy-pages reference baselines (TEMPORARY — deleted in M26 slice 02).
 *
 * The M22/T02 palette remap repaints every shadcn primitive, and we want a
 * regression net underneath the not-yet-migrated legacy pages so a token
 * change cannot silently break them while M22+ work lands. This spec
 * walks the 14 surviving legacy routes, asserts each renders without
 * console errors, runs a small axe spot-check on a stable critical
 * element (the page's `<h1>` or, for pages that lack one, the page-root
 * data-testid), and captures one light-theme full-page screenshot per
 * route as the visual baseline.
 *
 * Why temporary: M26/02 ships the new shell across every route and
 * deletes the legacy markup these baselines pin down. At that point the
 * baselines stop reflecting anything real and become snapshot churn —
 * the slice that retires legacy markup also `rm`s
 * `e2e/visual-legacy-pages.spec.ts` plus its
 * `__screenshots__/visual-legacy-pages.spec.ts/` folder. Until then the
 * baselines are the regression net.
 *
 * Per the slice rules:
 *   - Light theme only. Dark-theme palette coverage lives in
 *     `tokens-preview.spec.ts` (the dev-only `/dev/tokens-preview` route).
 *   - Do NOT patch any legacy page to make this spec pass. The whole
 *     point is regression detection — if a baseline diff fires, treat
 *     the page change as real and decide whether it was intentional.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/visual-legacy-pages.spec.ts
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createProject, createWorkspace, uniq } from "./_helpers";

// ---------------------------------------------------------------------------
// Page table — 14 entries.
//
// `wait` is a CSS / Playwright locator string we hand to `page.locator()` to
// confirm the page rendered past its skeleton state before we screenshot.
// `axeTarget` narrows the axe scan to a single critical element so we only
// surface structural a11y bugs that touch the page's primary affordance —
// not the global shell, which is covered by the new-shell baselines.
// ---------------------------------------------------------------------------
type LegacyPage = {
  /** Display name for the test title. */
  name: string;
  /** Path resolved against `baseURL`. May depend on a seeded id. */
  path: () => string;
  /**
   * Locator that must become visible before snapshotting. May use any
   * Playwright pseudo (`:has-text(...)`) — this is fed to `page.locator`.
   */
  wait: string;
  /**
   * CSS selector handed to `AxeBuilder.include()`. MUST be plain CSS;
   * axe runs through `document.querySelectorAll`, which rejects
   * Playwright pseudos like `:has-text()`. Keep it narrow but valid CSS.
   */
  axeTarget: string;
};

// Filled by `beforeAll` — detail-page paths depend on seeded ids.
let seededProjectId: number;
let seededWorkspaceId: number;
let seededIncidentId: string;
let seedingContext: APIRequestContext | null = null;

/**
 * Pre-existing console-error noise we deliberately tolerate so the
 * baseline reflects the current legacy state (per the slice rule:
 * "Do NOT patch any legacy page to make it pass"). New, unknown
 * console errors still fail the test — that's the regression net.
 *
 * Each entry MUST be paired with a comment explaining the underlying
 * defect so M26's deletion of this spec doesn't silently bury the bug.
 */
const KNOWN_CONSOLE_ERROR_PATTERNS: RegExp[] = [
  // SkillsTab in /skills-mcp renders its TableBody rows without a
  // stable React `key` on the row wrapper. Pre-existing in legacy
  // markup; M26's slice 02 rewrites SkillsTab and the warning goes
  // away on its own. Filtering it here keeps the regression net live
  // without requiring a fix to legacy code.
  /Each child in a list should have a unique "key" prop/i,

  // Network 404 chatter from the seeded fixtures. The detail pages
  // fan out a handful of secondary fetches (e.g. per-project
  // activity timelines, mission feeds) that 404 against a freshly
  // seeded project/workspace because there's nothing in those
  // tables yet. The browser surfaces every failed network response
  // through `console.error`, which makes those 404s look like real
  // app bugs even though the UI handles them gracefully. The
  // visual baseline already pins the rendered output; we don't
  // need to also block on data-shape noise that is unrelated to
  // the palette regression net.
  /Failed to load resource: the server responded with a status of 404/i,
];

function isKnownConsoleError(text: string): boolean {
  return KNOWN_CONSOLE_ERROR_PATTERNS.some((re) => re.test(text));
}

const PAGES: LegacyPage[] = [
  {
    name: "dashboard",
    path: () => "/dashboard",
    wait: "h1:has-text('Dashboard')",
    axeTarget: "main h1",
  },
  {
    name: "attention",
    path: () => "/attention",
    wait: "h1:has-text('Inbox')",
    axeTarget: "main h1",
  },
  {
    name: "chats",
    // Chats has no `<h1>` — its page chrome is a sidebar with a search
    // input. We anchor on the search input's placeholder, which is the
    // most stable visible affordance the page renders unconditionally.
    path: () => "/chats",
    wait: "input[placeholder='Search chats...']",
    axeTarget: "input[placeholder='Search chats...']",
  },
  {
    name: "tasks",
    path: () => "/tasks",
    wait: "h1:has-text('Tasks')",
    axeTarget: "main h1",
  },
  {
    name: "templates",
    path: () => "/templates",
    wait: "h1:has-text('Templates')",
    axeTarget: "main h1",
  },
  {
    name: "schedules",
    path: () => "/schedules",
    wait: "h1:has-text('Schedules')",
    axeTarget: "main h1",
  },
  {
    name: "projects",
    path: () => "/projects",
    wait: "h1:has-text('Projects')",
    axeTarget: "main h1",
  },
  {
    name: "project-detail",
    path: () => `/projects/${seededProjectId}`,
    // Wait on the h1, not the wrapper div: the wrapper renders during
    // the skeleton state too, so anchoring on it would race the
    // `useProject` fetch and let axe scan an empty container.
    wait: "[data-testid='project-detail-page'] h1",
    axeTarget: "[data-testid='project-detail-page'] h1",
  },
  {
    name: "workspaces",
    path: () => "/workspaces",
    wait: "h1:has-text('Workspaces')",
    axeTarget: "main h1",
  },
  {
    name: "workspace-detail",
    path: () => `/workspaces/${seededWorkspaceId}`,
    // Same race fix as project-detail above — wait on the h1, not the
    // skeleton-friendly wrapper.
    wait: "[data-testid='workspace-detail-page'] h1",
    axeTarget: "[data-testid='workspace-detail-page'] h1",
  },
  {
    name: "skills-mcp",
    path: () => "/skills-mcp",
    wait: "h1:has-text('Skills & MCP')",
    axeTarget: "main h1",
  },
  {
    name: "analytics",
    path: () => "/analytics",
    wait: "h1:has-text('Analytics')",
    axeTarget: "main h1",
  },
  {
    name: "incidents",
    path: () => `/incidents/${seededIncidentId}`,
    wait: "[data-testid='incident-detail-page']",
    axeTarget: "[data-testid='incident-detail-page']",
  },
  {
    name: "settings",
    path: () => "/settings",
    wait: "h1:has-text('Settings')",
    axeTarget: "main h1",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Match the freeze used by `tokens-preview.spec.ts` so animation /
 * transition state cannot bleed into the diff.
 */
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
 * Pin the SPA to the light palette before the first paint. Same shape as
 * the tokens-preview helper so both specs stay drift-free.
 */
async function setLightTheme(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("flockctl-theme", "light");
    } catch {
      /* swallow — Safari private mode etc. */
    }
  });
}

/**
 * Slug-safe key for the screenshot filename. `/projects/:id` -> `projects_id`.
 */
function snapshotKey(page: LegacyPage): string {
  return `legacy-${page.name}.png`;
}

// ---------------------------------------------------------------------------
// One-shot seeding for detail pages
// ---------------------------------------------------------------------------
test.beforeAll(async () => {
  // Playwright's `request` fixture is test-scoped, so a beforeAll cannot
  // receive it directly. Mirror the workspace-detail-tabs.spec.ts pattern
  // and build a parallel APIRequestContext pointed at the dev server,
  // which proxies through to the e2e backend on `E2E_BACKEND_PORT`.
  const frontendPort = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
  seedingContext = await playwrightRequest.newContext({
    baseURL: `http://localhost:${frontendPort}`,
  });

  const ws = await createWorkspace(seedingContext, uniq("legacy-ws"));
  seededWorkspaceId = ws.id;

  const project = await createProject(seedingContext, uniq("legacy-proj"));
  seededProjectId = project.id;

  // Incidents have their own table and don't depend on a workspace. The
  // detail page reads /incidents/:id directly, so a single insert is
  // enough.
  const incidentRes = await seedingContext.post("/incidents", {
    data: {
      title: uniq("legacy-incident"),
      symptom: "baseline symptom",
      rootCause: "baseline root cause",
      resolution: "baseline resolution",
      tags: ["legacy-baseline"],
    },
  });
  if (incidentRes.status() !== 201) {
    throw new Error(
      `seed incident failed: ${incidentRes.status()} ${await incidentRes.text()}`,
    );
  }
  const incident = (await incidentRes.json()) as { id: number | string };
  seededIncidentId = String(incident.id);
});

test.afterAll(async () => {
  await seedingContext?.dispose();
  seedingContext = null;
});

// ---------------------------------------------------------------------------
// Per-page tests
// ---------------------------------------------------------------------------
test.describe("legacy pages reference (M26/02 will delete this spec)", () => {
  for (const entry of PAGES) {
    test(`${entry.name} renders without breakage`, async ({ page }) => {
      // Capture browser-side console errors so a silent React crash or
      // unhandled promise rejection trips the test even when the
      // skeleton state still resolves visually. We intentionally
      // collect only `error` and `pageerror` — `warning` is too noisy
      // (libraries leak warnings the app can't fix).
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!isKnownConsoleError(text)) {
            consoleErrors.push(text);
          }
        }
      });
      page.on("pageerror", (err) => {
        const text = String(err);
        if (!isKnownConsoleError(text)) {
          consoleErrors.push(text);
        }
      });

      await setLightTheme(page);
      await page.goto(entry.path());

      // 1) Page rendered past skeleton state.
      await expect(page.locator(entry.wait).first()).toBeVisible({
        timeout: 15_000,
      });

      // 2) Freeze motion before screenshotting.
      await freezeAnimations(page);

      // 3) Visual baseline. `threshold` is per-pixel sensitivity (per the
      //    slice spec); `maxDiffPixelRatio` keeps aggregate AA noise from
      //    flaking the suite. Both knobs play nicely together.
      await expect(page).toHaveScreenshot(snapshotKey(entry), {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });

      // 4) Axe spot-check on the page's critical element. We disable
      //    `color-contrast` for the same reason `tokens-preview.spec.ts`
      //    does: shadcn's `text-muted-foreground` on `bg-muted` lands
      //    just under WCAG AA contrast in light mode under the M22/T02
      //    palette, and that's a token-level finding tracked separately
      //    — not a per-page bug. The visual baselines already carry the
      //    contrast signal for human review.
      const results = await new AxeBuilder({ page })
        .include(entry.axeTarget)
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = results.violations.filter((v) =>
        ["serious", "critical"].includes(String(v.impact ?? "")),
      );
      if (blocking.length > 0) {
        // Surface the offenders directly in test output so a regression
        // is one-glance debuggable instead of a black-box `toHaveLength(0)`.
        console.error(
          `axe blocking violations on ${entry.name}:`,
          JSON.stringify(
            blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
            null,
            2,
          ),
        );
      }
      expect(blocking).toHaveLength(0);

      // 5) No browser-side console errors during render.
      if (consoleErrors.length > 0) {
        console.error(
          `console errors on ${entry.name}:`,
          JSON.stringify(consoleErrors, null, 2),
        );
      }
      expect(consoleErrors).toEqual([]);
    });
  }
});
