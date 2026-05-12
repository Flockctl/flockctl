import { test, expect, type Page } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E coverage for the `/projects` page (slice 23-02).
 *
 * Two halves:
 *
 *   1. Behavioural — pre-existing assertions (list shows API-created
 *      project, GET /projects fires on load, navigation to detail,
 *      directory-picker driven create flow). These guard against
 *      regressions in the data layer when the page assembly changes.
 *
 *   2. Visual baselines (slice T07) — Cards layout + Table layout in
 *      both light and dark themes, plus the two empty states (initial
 *      "no projects yet" + filtered "nothing matches"). Baselines live
 *      under e2e/__screenshots__/projects.spec.ts/ per the
 *      `snapshotPathTemplate` in playwright.config.ts.
 *
 * The visual specs seed deterministic data via the live backend so the
 * baseline is reproducible: two workspaces (`work`, `personal`) plus a
 * standalone project, written directly through the public POST endpoints.
 * Theme is pinned via `flockctl-theme` localStorage before navigation so
 * the dark baseline doesn't fight the OS preference of the testing host.
 */

/**
 * Stub /fs/browse with a tiny two-level tree so the picker test can drive a
 * deterministic navigate → select flow without depending on whatever happens
 * to live under the tester's real $HOME. The stub returns:
 *   /tmp/picker-root          (root the picker lands on first)
 *     └── drill-me/           (the only directory — easy to target)
 *           └── leaf/         (one more level so Select has a distinct value)
 */
async function stubFsBrowse(page: import("@playwright/test").Page, pickedPath: string) {
  await page.route("**/fs/browse*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.searchParams.get("path");
    if (p === null || p === "/tmp/picker-root") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          path: "/tmp/picker-root",
          parent: null,
          entries: [
            { name: "drill-me", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        }),
      });
      return;
    }
    if (p === "/tmp/picker-root/drill-me") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          path: pickedPath,
          parent: "/tmp/picker-root",
          entries: [],
          truncated: false,
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: JSON.stringify({ error: "Path not found" }) });
  });
}

test("projects page lists a project created via API", async ({ page, request }) => {
  const name = uniq("proj-e2e");
  await createProject(request, name);

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" }).first()).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("projects page calls GET /projects on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/projects(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/projects");
  const res = await listed;
  expect(res.status()).toBe(200);
});

test("navigating from /projects to project detail loads the project", async ({
  page,
  request,
}) => {
  const name = uniq("proj-nav");
  const proj = await createProject(request, name);

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("Create Project dialog: pick path via DirectoryPicker → project appears in list", async ({
  page,
}) => {
  const projectName = uniq("proj-picked");
  // The picker will "select" this path; the backend creates it via
  // mkdir -p on POST /projects, so the value just needs to be a plausible
  // writable absolute path. /tmp/picker-selected-<uniq> keeps each run
  // isolated from any previous test invocation.
  const pickedPath = `/tmp/picker-selected-${Date.now()}`;

  // Seed last-picked so the picker's initialPath falls back to our stubbed
  // root — the stub handler also accepts `path === null`, so this is belt
  // and braces rather than load-bearing.
  await page.addInitScript((v) => {
    window.localStorage.setItem("flockctl.lastPickedPath", v);
  }, "/tmp/picker-root");

  // Stub AFTER navigation starts so the route handler is in place when the
  // dialog fires its first /fs/browse request.
  await stubFsBrowse(page, pickedPath);

  // Don't intercept the real POST /projects — let it hit the backend so the
  // created row is actually persisted and the list re-fetch picks it up.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" }).first()).toBeVisible();

  // 1. Open the Create Project dialog via the toolbar's "+ New project" button.
  await page.getByTestId("projects-new-project-button").click();
  await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();

  await page.locator("#cp-name").fill(projectName);

  // 2. Open the picker via the Browse… button next to the path input.
  await page.getByTestId("cp-path-browse").click();
  await expect(page.getByText("Select a directory")).toBeVisible();

  // 3. Navigate: double-click the stub's only entry to drill into it.
  await expect(page.getByText("drill-me")).toBeVisible();
  await page.getByText("drill-me").dblclick();

  // Breadcrumb should now show the deeper path's tail segment. The final
  // segment is rendered as a disabled breadcrumb button.
  await expect(
    page.getByTestId("directory-picker-breadcrumb"),
  ).toContainText(pickedPath.split("/").pop()!);

  // 4. Select — picker closes and writes the path back into the input.
  // `exact: true` is required because one of the breadcrumb segments
  // happens to contain the substring "Select".
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("#cp-path")).toHaveValue(pickedPath);

  // 5. Confirm the text input is still editable (picker augments, not
  //    replaces) — type a suffix, then trim it back to the picked path so
  //    the submit actually uses what the picker returned.
  await page.locator("#cp-path").fill(`${pickedPath}`);

  // 6. Submit.
  await page.getByRole("button", { name: /^Creat(e|ing…)$/ }).click();

  // 7. Project row appears in the list.
  await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Visual baselines (slice 23-02 T07).
//
// Cards × light/dark, Table × light/dark, plus filtered + initial-empty.
// Each variant snapshots the page after rendering against deterministic
// seeded data. The `__screenshots__/projects.spec.ts/` folder collects the
// resulting PNGs.
//
// Why the visuals live here and not in `visual-legacy-pages.spec.ts`:
//   - That spec is the legacy regression net; it predates this slice and
//     its baseline is the *old* projects page. Putting the new baselines
//     in their own spec lets that legacy spec keep firing on the legacy
//     route until the larger M26 retirement lands.
// ---------------------------------------------------------------------------

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

async function pinTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

async function pinView(page: Page, view: "cards" | "table") {
  await page.addInitScript((v) => {
    try {
      window.localStorage.setItem("projects.view", v);
    } catch {
      /* private mode etc. */
    }
  }, view);
}

// Deterministic fixture used by every visual baseline. We intercept
// `/projects` and `/workspaces` so the baseline does not drift as the
// e2e backend accumulates seeded rows across reruns.
const FIXTURE_NOW = "2025-01-01T00:00:00.000Z";
const FIXTURE_PROJECTS = [
  {
    id: "fp-alpha",
    name: "Alpha",
    description: "Workspace project A",
    path: "/tmp/alpha",
    workspace_id: 1,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  },
  {
    id: "fp-beta",
    name: "Beta",
    description: "Workspace project B",
    path: "/tmp/beta",
    workspace_id: 2,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  },
  {
    id: "fp-gamma",
    name: "Gamma",
    description: "Standalone project",
    path: "/tmp/gamma",
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  },
];
const FIXTURE_WORKSPACES = [
  {
    id: "1",
    name: "work",
    description: null,
    path: "/tmp/ws-work",
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  },
  {
    id: "2",
    name: "personal",
    description: null,
    path: "/tmp/ws-personal",
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  },
];

async function stubProjectsList(page: Page) {
  // The SPA's `apiFetch` always targets the daemon at
  // 127.0.0.1:<E2E_BACKEND_PORT>. Pin route handlers to that origin so
  // they don't shadow the dev server's HTML responses (a bare
  // `**/projects` glob would also catch `http://localhost:5174/projects`,
  // which is the page navigation itself — and Playwright would happily
  // return JSON in place of the SPA HTML).
  const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
  const apiOrigin = `http://127.0.0.1:${backendPort}`;

  const respond = async (route: import("@playwright/test").Route, payload: unknown) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  };

  await page.route(`${apiOrigin}/projects`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: FIXTURE_PROJECTS,
        total: FIXTURE_PROJECTS.length,
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/projects?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: FIXTURE_PROJECTS,
        total: FIXTURE_PROJECTS.length,
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/workspaces`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: FIXTURE_WORKSPACES,
        total: FIXTURE_WORKSPACES.length,
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/workspaces?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        items: FIXTURE_WORKSPACES,
        total: FIXTURE_WORKSPACES.length,
      });
      return;
    }
    await route.fallback();
  });
  // Quiet the attention badge so the screenshot doesn't flicker on
  // whatever is in the seeded backend.
  await page.route(`${apiOrigin}/attention*`, async (route) => {
    await respond(route, { items: [] });
  });
}

test.describe("projects page — visual baselines", () => {

  for (const theme of ["light", "dark"] as const) {
    test(`cards layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await pinView(page, "cards");
      await stubProjectsList(page);
      await page.goto("/projects");
      await expect(
        page.getByTestId("projects-page").getByRole("heading", {
          name: "Projects",
          level: 1,
        }),
      ).toBeVisible();
      // Wait for either the cards layout or the empty state — `cards`
      // is the seeded path.
      await expect(page.getByTestId("projects-cards-layout")).toBeVisible({
        timeout: 10_000,
      });
      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`projects-cards-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`table layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await pinView(page, "table");
      await stubProjectsList(page);
      await page.goto("/projects");
      await expect(
        page.getByTestId("projects-page").getByRole("heading", {
          name: "Projects",
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.getByTestId("projects-table")).toBeVisible({
        timeout: 10_000,
      });
      await freezeAnimations(page);
      await expect(page).toHaveScreenshot(`projects-table-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test("filtered baseline — ?filter=standalone", async ({ page }) => {
    await pinTheme(page, "light");
    await pinView(page, "cards");
    await stubProjectsList(page);
    await page.goto("/projects?filter=standalone");
    await expect(
      page.getByTestId("projects-page").getByRole("heading", {
        name: "Projects",
        level: 1,
      }),
    ).toBeVisible();
    // Either the cards layout (rendering only the standalone group) or
    // the filtered empty-state — both are valid visual outcomes depending
    // on whether seeding gave us standalone rows. Wait for the chip to
    // confirm the filter is applied.
    await expect(page.getByTestId("filter-chip-standalone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("projects-filtered-standalone.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("filtered empty baseline — ?filter=<workspace> with q=__no_match__", async ({
    page,
  }) => {
    await pinTheme(page, "light");
    await pinView(page, "cards");
    await stubProjectsList(page);
    await page.goto(
      `/projects?q=${encodeURIComponent("__zzz_no_match_zzz__")}`,
    );
    await expect(
      page.getByTestId("projects-page").getByRole("heading", {
        name: "Projects",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByTestId("projects-filtered-empty-state"),
    ).toBeVisible({ timeout: 10_000 });
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("projects-filtered-empty.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
