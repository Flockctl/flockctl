import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createWorkspace, createProject, createTemplate, uniq } from "./_helpers";

/**
 * Workspace-detail shell — tab-state + panel content + pixel baselines.
 *
 * The workspace detail page is a URL-backed Tabs shell (plan / runs /
 * templates / config). This spec covers three layers:
 *
 *   1. Tab-state wiring (slice 00): clicking writes `?tab=` to the URL,
 *      deep-linked `?tab=runs` survives a hard reload, and an
 *      XSS-shaped `?tab=<script>…</script>` falls back to Plan without
 *      echoing the raw payload into the DOM. The underlying hook's
 *      allow-list logic is covered in
 *      `ui/src/lib/__tests__/use-workspace-tab.test.ts`.
 *   2. Panel content (tasks 00–02): Plan renders {@link ProjectsAccordion}
 *      for a workspace with projects; Runs renders per-project link
 *      buttons (or an empty CTA when no projects exist); Templates
 *      renders the {@link WorkspaceTemplatesSection} table plus a
 *      Schedules stub.
 *   3. Pixel baselines for the new shell: two Plan states
 *      (with-projects / empty), Runs empty, and Templates-with-template.
 *
 * Two fixtures back these tests:
 *
 *   - `seededWorkspace` (beforeAll) — a workspace with one stable-named
 *     project and one workspace-scoped template. Guarantees the
 *     "with projects + template" content state exists without depending
 *     on test ordering or carrying it from a previous spec.
 *   - `emptyWorkspace` — freshly created per-test via `createWorkspace`
 *     for empty-state baselines and for the tab-state interaction tests,
 *     which don't care about panel content and benefit from isolation.
 *
 * Baselines live under `ui/e2e/__screenshots__/workspace-detail-tabs.spec.ts/`
 * (see `snapshotPathTemplate` in `playwright.config.ts`). Regenerate with:
 *
 *   cd ui && npm run e2e:update -- workspace-detail-tabs.spec.ts
 */

/** Stable names for the seeded workspace's children — safe because the
 *  parent workspace itself uses `uniq()`, so even though these strings
 *  repeat across runs they never collide across workspaces. Stability
 *  matters for pixel baselines: a fresh UUID in the project summary
 *  would break every rerun of the "with projects" screenshot. */
const SEED_PROJECT_NAME = "Seed Project";
const SEED_TEMPLATE_NAME = "seed-template";

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
 * Wait until the workspace-detail page has finished its first render.
 *
 * A fresh workspace renders a `<h1>` with its name once `useWorkspace`
 * resolves. Waiting on that heading plus the Tabs container guarantees
 * the page has moved past its skeleton state before we interact with it
 * or snapshot the shell.
 */
async function waitWorkspaceShell(page: Page, name: string) {
  await expect(page.getByTestId("workspace-detail-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("workspace-detail-tabs")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("workspace-detail tab shell", () => {
  // Seeded workspace shared by the "with content" behavioral tests and
  // the Plan-with-projects / Templates pixel baselines. Built in
  // `beforeAll` so the cost (workspace + project + template round-trips)
  // is paid once per file rather than per test.
  let seededWorkspaceId: number;
  let seededWorkspaceName: string;
  let seededProjectId: number;
  let seedingContext: APIRequestContext | null = null;

  test.beforeAll(async () => {
    // Playwright's `request` fixture is test-scoped, so `beforeAll`
    // cannot receive it directly. We build a parallel APIRequestContext
    // that points at the Vite dev server (which proxies `/workspaces`,
    // `/projects`, `/templates` straight through to the backend on
    // port `E2E_BACKEND_PORT`).
    const frontendPort = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
    seedingContext = await playwrightRequest.newContext({
      baseURL: `http://localhost:${frontendPort}`,
    });

    seededWorkspaceName = uniq("ws-tab-seeded");
    const ws = await createWorkspace(seedingContext, seededWorkspaceName);
    seededWorkspaceId = ws.id;

    // Project path is kept workspace-unique so reruns that share
    // `.e2e-data` don't recreate the same `/tmp/Seed Project` dir
    // (which would be confusing even if not strictly wrong).
    const project = await createProject(seedingContext, SEED_PROJECT_NAME, {
      workspaceId: ws.id,
      path: `/tmp/ws-${ws.id}-seed-project`,
    });
    seededProjectId = project.id;

    await createTemplate(seedingContext, SEED_TEMPLATE_NAME, {
      scope: "workspace",
      workspaceId: ws.id,
    });
  });

  test.afterAll(async () => {
    await seedingContext?.dispose();
  });

  // ---------------------------------------------------------------
  // Tab-state wiring (slice 00 — unchanged)
  // ---------------------------------------------------------------

  test("clicking each tab updates ?tab= in the URL", async ({ page, request }) => {
    const name = uniq("ws-tab-click");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}`);
    await waitWorkspaceShell(page, name);

    // Default resolution — Plan is active even when the URL carries no
    // `?tab=` param.
    await expect(page.getByTestId("workspace-detail-tab-plan")).toHaveAttribute(
      "data-state",
      "active",
    );

    // Clicking each trigger must (a) activate that tab and (b) write the
    // matching `?tab=` value to the URL via `setSearchParams({ replace: true })`.
    await page.getByTestId("workspace-detail-tab-runs").click();
    await expect(page).toHaveURL(/[?&]tab=runs(&|$)/);
    await expect(page.getByTestId("workspace-detail-tab-runs")).toHaveAttribute(
      "data-state",
      "active",
    );

    await page.getByTestId("workspace-detail-tab-templates").click();
    await expect(page).toHaveURL(/[?&]tab=templates(&|$)/);
    await expect(
      page.getByTestId("workspace-detail-tab-templates"),
    ).toHaveAttribute("data-state", "active");

    await page.getByTestId("workspace-detail-tab-config").click();
    await expect(page).toHaveURL(/[?&]tab=config(&|$)/);
    await expect(
      page.getByTestId("workspace-detail-tab-config"),
    ).toHaveAttribute("data-state", "active");

    // Back to Plan — the setter must write `?tab=plan` explicitly rather
    // than stripping the param (the hook always writes, merge-style).
    await page.getByTestId("workspace-detail-tab-plan").click();
    await expect(page).toHaveURL(/[?&]tab=plan(&|$)/);
    await expect(page.getByTestId("workspace-detail-tab-plan")).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("deep-link to ?tab=runs survives a full reload", async ({ page, request }) => {
    const name = uniq("ws-tab-reload");
    const ws = await createWorkspace(request, name);

    await page.goto(`/workspaces/${ws.id}?tab=runs`);
    await waitWorkspaceShell(page, name);
    await expect(page.getByTestId("workspace-detail-tab-runs")).toHaveAttribute(
      "data-state",
      "active",
    );

    // Hard reload. `useWorkspaceTab` reads from the URL on every render,
    // so the reload must not flip us back to the default tab.
    await page.reload();
    await waitWorkspaceShell(page, name);
    await expect(page).toHaveURL(/[?&]tab=runs(&|$)/);
    await expect(page.getByTestId("workspace-detail-tab-runs")).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("XSS-shaped ?tab= falls back to Plan and is never echoed into the DOM", async ({
    page,
    request,
  }) => {
    const name = uniq("ws-tab-xss");
    const ws = await createWorkspace(request, name);

    // Classic script-injection shape. If the hook ever dropped its
    // allow-list and echoed the raw param into the DOM, this payload
    // would either execute or appear verbatim — neither is acceptable.
    const payload = "<script>alert('flockctl-ws-tab-xss')</script>";
    const encoded = encodeURIComponent(payload);

    // Hook into the browser so we can detect any injected script
    // actually running. The `__xssFired` flag is flipped inside
    // `window.alert` — if the payload ever escapes sanitisation and
    // executes, the flag goes true and the assertion below fails.
    await page.addInitScript(() => {
      (window as unknown as { __xssFired?: boolean }).__xssFired = false;
      const orig = window.alert;
      window.alert = (...args: unknown[]) => {
        (window as unknown as { __xssFired?: boolean }).__xssFired = true;
        return orig.apply(window, args as []);
      };
    });

    await page.goto(`/workspaces/${ws.id}?tab=${encoded}`);
    await waitWorkspaceShell(page, name);

    // Invalid param → hook silently resolves to `'plan'`.
    await expect(page.getByTestId("workspace-detail-tab-plan")).toHaveAttribute(
      "data-state",
      "active",
    );

    // The raw payload must NOT appear anywhere in the tab container's
    // inner text — the only way it could is through unescaped
    // interpolation of the URL param into a rendered node.
    const tabsContainer = page.getByTestId("workspace-detail-tabs");
    const inner = await tabsContainer.innerText();
    expect(inner).not.toContain(payload);

    // And no alert must have fired during navigation / first render.
    const fired = await page.evaluate(
      () => (window as unknown as { __xssFired?: boolean }).__xssFired === true,
    );
    expect(fired).toBe(false);
  });

  // ---------------------------------------------------------------
  // Panel content (tasks 00–02)
  //
  // Three behavioral cases — one per tab rebuilt this milestone — that
  // assert the new components render the right shape when a workspace
  // has projects / templates. The tab-state tests above use empty
  // workspaces; these use the beforeAll-seeded one.
  // ---------------------------------------------------------------

  test("Plan tab renders ProjectsAccordion with the seeded project", async ({
    page,
  }) => {
    await page.goto(`/workspaces/${seededWorkspaceId}?tab=plan`);
    await waitWorkspaceShell(page, seededWorkspaceName);

    // `ProjectsAccordion` is the replacement for the old inline Project
    // Overview card — it should be present exactly when summaries are
    // non-empty. Rendering `null` for `length === 0` means the testid
    // attaches to the *Card* (not to a wrapper), so its presence is
    // itself evidence that the accordion path fired.
    const accordion = page.getByTestId("workspace-projects-accordion");
    await expect(accordion).toBeVisible();
    await expect(accordion).toContainText("Project Overview");
    await expect(accordion).toContainText(SEED_PROJECT_NAME);
    // Milestone count literal from `ProjectsAccordion`'s `<summary>`.
    await expect(accordion).toContainText("(0 milestones)");
  });

  test("Runs tab renders a per-project link for the seeded project", async ({
    page,
  }) => {
    await page.goto(`/workspaces/${seededWorkspaceId}?tab=runs`);
    await waitWorkspaceShell(page, seededWorkspaceName);

    // `WorkspaceRunsTab` is pure routing: it renders one outline-variant
    // Button per project, each `href`-linked to that project's Runs
    // tab. Assert both the container testid and the per-project link
    // testid fire, and that the link's href points at the project-side
    // Runs tab.
    const links = page.getByTestId("workspace-runs-project-links");
    await expect(links).toBeVisible();

    const projectLink = page.getByTestId(
      `workspace-runs-project-link-${seededProjectId}`,
    );
    await expect(projectLink).toBeVisible();
    await expect(projectLink).toContainText(SEED_PROJECT_NAME);
    // Button uses `asChild` + react-router's `<Link>`, so the element
    // carrying our testid *is* the anchor — its `href` should link to
    // the project-side Runs tab.
    await expect(projectLink).toHaveAttribute(
      "href",
      `/projects/${seededProjectId}?tab=runs`,
    );

    // Empty CTA (the alternative branch) must NOT be present.
    await expect(page.getByTestId("workspace-runs-empty-cta")).toHaveCount(0);
  });

  test("Templates tab renders the seeded template row and Schedules stub", async ({
    page,
  }) => {
    await page.goto(`/workspaces/${seededWorkspaceId}?tab=templates`);
    await waitWorkspaceShell(page, seededWorkspaceName);

    const tab = page.getByTestId("workspace-templates-schedules-tab");
    await expect(tab).toBeVisible();

    // `WorkspaceTemplatesSection` renders the table once `useTemplates`
    // resolves non-empty. The seeded template name is what we assert on —
    // asserting on the Create button alone would pass even when the
    // table rendered the empty-state hint.
    await expect(tab.getByRole("cell", { name: SEED_TEMPLATE_NAME })).toBeVisible();

    // Empty-state hint must be gone. It renders as a `<p>` immediately
    // under the Templates heading, so a negative text assertion is
    // tight enough without a dedicated testid.
    await expect(tab).not.toContainText("No workspace-scoped templates yet.");

    // Schedules stub — present even though workspace-level schedules
    // aren't implemented yet. Guards against someone dropping the stub
    // when wiring real schedules later.
    await expect(page.getByTestId("workspace-schedules-stub")).toBeVisible();
    await expect(page.getByTestId("workspace-schedules-stub")).toContainText(
      "Schedules",
    );
  });

  // ---------------------------------------------------------------
  // Pixel baselines
  //
  // Four screenshots that cover the new shell's visual rhythm:
  //   - Plan with projects (seeded workspace)
  //   - Plan empty        (fresh workspace)
  //   - Runs empty        (fresh workspace)
  //   - Templates         (seeded workspace, seeded template)
  //
  // We snapshot the `workspace-detail-tabs` container rather than the
  // full page — the page header carries a `Created {timeAgo}` cell that
  // is wall-clock dependent and would otherwise require `page.clock`
  // plumbing for every run. The templates baseline additionally masks
  // the "Updated" column, which renders `formatTime(tpl.updated_at)`.
  // ---------------------------------------------------------------

  test("Plan tab (with projects) matches baseline", async ({ page }) => {
    await page.goto(`/workspaces/${seededWorkspaceId}?tab=plan`);
    await waitWorkspaceShell(page, seededWorkspaceName);
    await expect(
      page.getByTestId("workspace-detail-tab-plan"),
    ).toHaveAttribute("data-state", "active");
    // Wait until the accordion has mounted so the screenshot doesn't
    // race the `useWorkspaceDashboard` promise.
    await expect(page.getByTestId("workspace-projects-accordion")).toBeVisible();

    await freeze(page);
    await expect(page.getByTestId("workspace-detail-tabs")).toHaveScreenshot(
      "workspace-detail-plan-tab-with-projects.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("Plan tab (empty) matches baseline", async ({ page, request }) => {
    const name = uniq("ws-tab-plan-empty");
    const ws = await createWorkspace(request, name);
    await page.goto(`/workspaces/${ws.id}?tab=plan`);
    await waitWorkspaceShell(page, name);
    await expect(
      page.getByTestId("workspace-detail-tab-plan"),
    ).toHaveAttribute("data-state", "active");
    // `ProjectsAccordion` always renders the "Project Overview" card
    // (with an Add Project trigger in the header and an empty-state
    // message in the body) — that is the ONLY UI affordance for
    // attaching the first project to a fresh workspace, so it must be
    // reachable here. We use `toBeAttached` rather than `toBeVisible`
    // because the same testid is also carried by the pre-load
    // skeleton; the assertion below will only resolve once the
    // dashboard query transitions to empty.
    await expect(page.getByTestId("workspace-plan-tab")).toBeAttached();
    // Beat the `useWorkspaceDashboard` query by waiting on its network
    // round-trip to finish; otherwise the skeleton might still be on
    // screen at screenshot time.
    await page.waitForLoadState("networkidle");

    await freeze(page);
    await expect(page.getByTestId("workspace-detail-tabs")).toHaveScreenshot(
      "workspace-detail-plan-tab-empty.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("Runs tab (empty) matches baseline", async ({ page, request }) => {
    const name = uniq("ws-tab-runs-empty");
    const ws = await createWorkspace(request, name);
    await page.goto(`/workspaces/${ws.id}?tab=runs`);
    await waitWorkspaceShell(page, name);
    await expect(
      page.getByTestId("workspace-detail-tab-runs"),
    ).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("workspace-runs-empty-cta")).toBeVisible();

    await freeze(page);
    await expect(page.getByTestId("workspace-detail-tabs")).toHaveScreenshot(
      "workspace-detail-runs-tab-empty.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("Templates tab matches baseline", async ({ page }) => {
    await page.goto(`/workspaces/${seededWorkspaceId}?tab=templates`);
    await waitWorkspaceShell(page, seededWorkspaceName);
    await expect(
      page.getByTestId("workspace-detail-tab-templates"),
    ).toHaveAttribute("data-state", "active");
    // Wait for the seeded template row so the screenshot isn't taken
    // mid-fetch.
    await expect(
      page.getByRole("cell", { name: SEED_TEMPLATE_NAME }),
    ).toBeVisible();

    await freeze(page);
    await expect(page.getByTestId("workspace-detail-tabs")).toHaveScreenshot(
      "workspace-detail-templates-tab.png",
      {
        // `formatTime(tpl.updated_at)` renders a relative timestamp that
        // drifts as the clock advances; mask the whole Updated column
        // (5th cell of every body row) to keep the baseline stable.
        mask: [
          page.locator(
            "[data-testid='workspace-templates-schedules-tab'] tbody tr td:nth-child(5)",
          ),
        ],
        maxDiffPixelRatio: 0.02,
      },
    );
  });
});
