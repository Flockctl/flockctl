import { test, expect, type Page, type Route } from "@playwright/test";
import { createTemplate, uniq } from "./_helpers";

/**
 * E2E coverage for the `/templates` page (slice
 * `25-ui-redesign-library-surfaces/00-templates` T03).
 *
 * Two halves:
 *
 *   1. Behavioural — list shows API-created template, GET /templates
 *      fires on load, "Open in chat" creates a new chat and navigates
 *      to it.
 *
 *   2. Visual baselines (slice T03 expected_output) — default grid +
 *      open dialog × light/dark + the initial empty state. Baselines
 *      live under `e2e/__screenshots__/templates.spec.ts/` per the
 *      `snapshotPathTemplate` in `playwright.config.ts`.
 *
 * Visual specs intercept the daemon's list endpoints so the snapshot
 * is reproducible regardless of whatever templates the e2e backend has
 * accumulated. The clock is pinned to T_NOW so the cards' "Xm ago"
 * footer renders the same string on every run.
 */

// ---------------------------------------------------------------------------
// Fixtures + freeze helpers
// ---------------------------------------------------------------------------

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

async function pinTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

const T_NOW = "2026-04-23T10:00:00.000Z";
const T_CREATED = "2026-04-23T09:55:00.000Z";

const FIXTURE_TEMPLATES = [
  {
    name: "nightly-build",
    scope: "global",
    workspace_id: null,
    project_id: null,
    description: "Run the nightly build, smoke-test, and post the report.",
    agent: "claude-code",
    model: "claude-sonnet-4-20250514",
    prompt: "Run the build.",
    working_dir: "/tmp/nightly",
    env_vars: null,
    timeout_seconds: 600,
    label_selector: null,
    image: null,
    source_path: "/global/templates/nightly-build.json",
    created_at: T_CREATED,
    updated_at: T_CREATED,
  },
  {
    name: "deploy-staging",
    scope: "workspace",
    workspace_id: "1",
    project_id: null,
    description: "Deploy the latest commit to staging and tail the logs.",
    agent: "claude-code",
    model: "claude-opus-4-20250514",
    prompt: "Deploy to staging.",
    working_dir: "/tmp/staging",
    env_vars: null,
    timeout_seconds: 900,
    label_selector: null,
    image: null,
    source_path: "/ws/templates/deploy-staging.json",
    created_at: T_CREATED,
    updated_at: T_CREATED,
  },
  {
    name: "rotate-keys",
    scope: "project",
    workspace_id: null,
    project_id: "1",
    description: "Rotate API keys for prod and verify each downstream consumer.",
    agent: "claude-code",
    model: null,
    prompt: "Rotate.",
    working_dir: "/tmp/rotate",
    env_vars: null,
    timeout_seconds: 300,
    label_selector: null,
    image: null,
    source_path: "/proj/templates/rotate-keys.json",
    created_at: T_CREATED,
    updated_at: T_CREATED,
  },
];

const FIXTURE_WORKSPACES = [
  {
    id: "1",
    name: "Primary",
    description: null,
    path: "/tmp/primary",
    allowed_key_ids: [1],
    gitignore_flockctl: false,
    gitignore_todo: false,
    gitignore_agents_md: false,
    created_at: T_CREATED,
    updated_at: T_CREATED,
  },
];
const FIXTURE_PROJECTS = [
  {
    id: "1",
    name: "Primary Project",
    description: null,
    path: "/tmp/primary",
    workspace_id: 1,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: T_CREATED,
    updated_at: T_CREATED,
  },
];

interface StubOpts {
  templates?: typeof FIXTURE_TEMPLATES;
}

/**
 * Stub every endpoint the templates page hydrates off so the visual
 * baselines never drift with the backend's accumulated seed state.
 */
async function stubTemplatesEndpoints(page: Page, opts: StubOpts = {}): Promise<void> {
  const templates = opts.templates ?? FIXTURE_TEMPLATES;
  const json = (o: unknown) => JSON.stringify(o);

  async function handleTemplates(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({
        items: templates,
        total: templates.length,
        offset: 0,
        limit: templates.length,
      }),
    });
  }

  async function handleWorkspaces(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({
        items: FIXTURE_WORKSPACES,
        total: FIXTURE_WORKSPACES.length,
      }),
    });
  }

  async function handleProjects(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({
        items: FIXTURE_PROJECTS,
        total: FIXTURE_PROJECTS.length,
      }),
    });
  }

  async function handleAttention(route: Route) {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({ items: [], total: 0 }),
    });
  }

  await page.route(/\/templates(\?[^/]*)?$/, handleTemplates);
  await page.route(/\/workspaces(\?[^/]*)?$/, handleWorkspaces);
  await page.route(/\/projects(\?[^/]*)?$/, handleProjects);
  await page.route(/\/attention(\?[^/]*)?$/, handleAttention);
}

// ---------------------------------------------------------------------------
// Behavioural specs
// ---------------------------------------------------------------------------

test("templates page lists a template created via API", async ({ page, request }) => {
  const name = uniq("tmpl-e2e");
  // The shared `createTemplate` helper omits `scope`, which the
  // backend now requires (POST /templates → 422 without it). The
  // helper takes an `extra` bag — pass scope explicitly so the seed
  // round-trips before the page navigation asserts.
  await createTemplate(request, name, { scope: "global" });

  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("templates page calls GET /templates on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/templates(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/templates");
  const res = await listed;
  expect(res.status()).toBe(200);
});

// Negative test (per task spec): clicking "Open in chat" on a card creates
// a chat and navigates to it. We stub the templates endpoint so the
// seeded row is guaranteed to be on the first page (the e2e backend's
// real /templates payload accumulates across reruns and the redesigned
// page caps at 200 rows).
test("Open in chat creates a chat and navigates to /chats/:id", async ({
  page,
}) => {
  await stubTemplatesEndpoints(page);

  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();

  const card = page.getByTestId("template-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // The footer button (rendered by FlatCard's `footer` slot) sits as a
  // sibling of the `template-card` div, not a descendant — so we
  // resolve it at the page level rather than scoped to the card.
  const openInChat = page.getByTestId("template-card-open-in-chat").first();
  await openInChat.scrollIntoViewIfNeeded();
  await openInChat.click();
  await page.waitForURL(/\/chats\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Visual baselines (slice 25-00 T03).
//
// Default grid × light/dark, dialog × light/dark, plus the initial empty
// state. Baselines live under e2e/__screenshots__/templates.spec.ts/ per
// the `snapshotPathTemplate` in playwright.config.ts.
// ---------------------------------------------------------------------------

test.describe("templates page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`grid layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await stubTemplatesEndpoints(page);

      await page.goto("/templates");
      await expect(
        page
          .getByTestId("templates-page")
          .getByRole("heading", { name: "Templates", level: 1 }),
      ).toBeVisible();
      // Wait for the grid + every card before snapshotting — otherwise
      // the page may still be mid-fade when Playwright takes the shot.
      await expect(page.getByTestId("templates-grid")).toBeVisible({
        timeout: 10_000,
      });
      const cards = page.getByTestId("template-card");
      await expect(cards).toHaveCount(FIXTURE_TEMPLATES.length);

      await freeze(page);
      await expect(page).toHaveScreenshot(`templates-grid-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`new-template dialog — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await stubTemplatesEndpoints(page);

      await page.goto("/templates");
      await expect(
        page
          .getByTestId("templates-page")
          .getByRole("heading", { name: "Templates", level: 1 }),
      ).toBeVisible();

      // Open the dialog from the toolbar's "+ New template" button. The
      // button only renders once the templates list has loaded (the
      // toolbar is suppressed on loading/error), so the await above
      // doubles as a load-gate.
      await page.getByTestId("templates-new-template-button").click();

      const dialog = page.getByTestId("new-template-dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByRole("heading", { name: /^Create Template$/ }),
      ).toBeVisible();

      await freeze(page);
      await expect(dialog).toHaveScreenshot(`templates-new-dialog-${theme}.png`, {
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test("empty state — no templates", async ({ page }) => {
    await pinTheme(page, "light");
    await page.clock.install({ time: new Date(T_NOW) });
    // Empty payload from /templates so the page settles into the
    // initial-empty branch (not the filtered-empty branch which lives on
    // a search result).
    await stubTemplatesEndpoints(page, { templates: [] });

    await page.goto("/templates");
    await expect(page.getByTestId("templates-empty-state")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("templates-empty-cta")).toBeVisible();

    await freeze(page);
    await expect(page).toHaveScreenshot("templates-empty.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
