import { test, expect, type Page, type Route } from "@playwright/test";
import { uniq } from "./_helpers";

// ---------------------------------------------------------------------------
// Visual baselines (Schedules visual baselines slice).
//
// Page-assembly snapshots: SectionHeader → toolbar → SchedulesTable in
// both light and dark themes, plus the empty state in both themes.
// Baselines live under e2e/__screenshots__/schedules.spec.ts/ per the
// `snapshotPathTemplate` in playwright.config.ts.
//
// Both default and empty cases seed the list endpoints via `page.route`
// rather than the API — the relative-time cells in the table
// (`Next run`, `Last run`) are wall-clock-derived from
// `next_fire_time` / `last_fire_time` and would drift the baseline by a
// minute-bucket per minute of clock drift on the e2e runner. Freezing
// the clock plus fixed fixture timestamps pins those strings on every
// run. The CreateScheduleDialog component also fetches `/templates` and
// `/keys` on mount (see ui/src/pages/schedules-components/create-schedule-dialog.tsx),
// so those endpoints are stubbed too — without them the queries would
// hit the e2e backend and rehydrate the page mid-snapshot.
//
// Regenerate baselines with:
//   cd ui && npm run e2e:update -- e2e/schedules.spec.ts
// ---------------------------------------------------------------------------

const T_NOW = "2026-04-23T10:00:00.000Z";
// last_fire_time = 5m ago, next_fire_time = 1h ahead → both render as
// pixel-stable mono strings inside the table cells.
const T_LAST_FIRE = "2026-04-23T09:55:00.000Z";
const T_NEXT_FIRE = "2026-04-23T11:00:00.000Z";
const T_CREATED = "2026-04-22T10:00:00.000Z";

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

interface ScheduleSeed {
  id: string;
  template_scope: "global" | "workspace" | "project";
  template_name: string;
  cron_expression: string | null;
  status: "active" | "paused" | "expired";
}

async function routeSchedulesEndpoints(
  page: Page,
  seeds: ReadonlyArray<ScheduleSeed>,
): Promise<void> {
  const items = seeds.map((s) => ({
    id: s.id,
    template_scope: s.template_scope,
    template_name: s.template_name,
    template_workspace_id: null,
    template_project_id: null,
    assigned_key_id: null,
    schedule_type: "cron",
    cron_expression: s.cron_expression,
    run_at: null,
    timezone: "UTC",
    status: s.status,
    last_fire_time: s.status === "active" ? T_LAST_FIRE : null,
    next_fire_time: s.status === "active" ? T_NEXT_FIRE : null,
    misfire_grace_seconds: 60,
    created_at: T_CREATED,
    updated_at: T_CREATED,
  }));

  const jsonBody = (o: unknown) => JSON.stringify(o);

  async function handleSchedules(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items, total: items.length, offset: 0, limit: 20 }),
    });
  }

  // CreateScheduleDialog mounts useTemplates + useAIKeys on render —
  // stub both with empty payloads so the dialog's react-query layer
  // settles instead of leaving in-flight requests behind the snapshot.
  async function handleTemplates(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items: [], total: 0, offset: 0, limit: 100 }),
    });
  }

  async function handleKeys(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ items: [], total: 0 }),
    });
  }

  await page.route(/\/schedules(\?[^/]*)?$/, handleSchedules);
  await page.route(/\/templates(\?[^/]*)?$/, handleTemplates);
  await page.route(/\/keys(\?[^/]*)?$/, handleKeys);
}

test.describe("schedules page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`default layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await routeSchedulesEndpoints(page, [
        {
          id: "sched-1",
          template_scope: "global",
          template_name: "nightly-build",
          cron_expression: "0 0 * * *",
          status: "active",
        },
        {
          id: "sched-2",
          template_scope: "workspace",
          template_name: "deploy-staging",
          cron_expression: "*/15 * * * *",
          status: "active",
        },
        {
          id: "sched-3",
          template_scope: "project",
          template_name: "healthcheck-paused",
          cron_expression: "0 * * * *",
          status: "paused",
        },
      ]);

      await page.goto("/schedules");
      await expect(
        page.getByRole("heading", { name: "Schedules" }),
      ).toBeVisible({ timeout: 10_000 });
      // Wait for the table to settle — every body row needs to be
      // present before the snapshot, otherwise the layout will be
      // mid-render when Playwright takes the picture.
      await expect(page.getByTestId("schedules-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("schedules-table-row")).toHaveCount(3, {
        timeout: 10_000,
      });

      await freeze(page);
      await expect(page).toHaveScreenshot(`schedules-default-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`empty state — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await routeSchedulesEndpoints(page, []);

      await page.goto("/schedules");
      await expect(
        page.getByRole("heading", { name: "Schedules" }),
      ).toBeVisible({ timeout: 10_000 });
      // Empty branch renders "No schedules yet." — wait for that copy
      // before snapshotting so the diff doesn't catch an in-flight
      // skeleton state.
      await expect(page.getByText("No schedules yet.")).toBeVisible({
        timeout: 10_000,
      });

      await freeze(page);
      await expect(page).toHaveScreenshot(`schedules-empty-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test("schedules page lists a cron schedule created via API", async ({ page, request }) => {
  const tmplName = uniq("sched-tmpl");
  const tmplRes = await request.post("/templates", {
    data: {
      name: tmplName,
      scope: "global",
      prompt: "template prompt",
      agent: "claude-code",
      workingDir: "/tmp/template",
    },
  });
  if (tmplRes.status() !== 201) {
    throw new Error(`createTemplate failed: ${tmplRes.status()} ${await tmplRes.text()}`);
  }

  const schedRes = await request.post("/schedules", {
    data: {
      templateScope: "global",
      templateName: tmplName,
      scheduleType: "cron",
      cronExpression: "0 */6 * * *",
      timezone: "UTC",
    },
  });
  expect(schedRes.status()).toBe(201);

  await page.goto("/schedules");
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByText(tmplName).first()).toBeVisible({ timeout: 10_000 });
});

test("schedules page calls GET /schedules on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/schedules(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/schedules");
  const res = await listed;
  expect(res.status()).toBe(200);
});
