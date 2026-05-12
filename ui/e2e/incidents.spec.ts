import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * E2E coverage for the `/incidents` list page + `/incidents/:id` detail
 * page (slice `25-ui-redesign-library-surfaces/04-incidents` T02 page
 * assembly + visual baselines).
 *
 * Layers:
 *
 *   1. Behavioural — list calls GET /incidents on load, row click navigates
 *      to /incidents/:id, and a 404 incident renders an error block with
 *      a back-link to /incidents.
 *
 *   2. Visual baselines — list × light/dark + empty-state, detail × light/
 *      dark. Baselines live under
 *      `e2e/__screenshots__/incidents.spec.ts/` per the
 *      `snapshotPathTemplate` in `playwright.config.ts`.
 *
 * Visual specs intercept the daemon's list/detail endpoints so the
 * snapshot is reproducible regardless of whatever the e2e backend has
 * accumulated. The clock is pinned to T_NOW so the table's `Opened` /
 * `Resolved` columns and the detail timeline render the same relative
 * strings on every run.
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
const T_OPENED_2H = "2026-04-23T08:00:00.000Z";
const T_OPENED_1D = "2026-04-22T10:00:00.000Z";
const T_OPENED_3D = "2026-04-20T10:00:00.000Z";
const T_RESOLVED_1H = "2026-04-23T09:00:00.000Z";

interface IncidentSeed {
  id: number;
  title: string;
  symptom: string | null;
  root_cause: string | null;
  resolution: string | null;
  tags: string[] | null;
  project_id: string | null;
  created_by_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

const FIXTURE_INCIDENTS: IncidentSeed[] = [
  {
    id: 1,
    title: "Postgres OOM during nightly backup",
    symptom: "Backup pod OOM-killed at 02:14 UTC; backup left a partial dump.",
    root_cause: "WAL replay buffer sized at 4Gi, pod limit 3Gi.",
    resolution: "Bumped pod limit to 6Gi and pinned WAL buffer to 2Gi.",
    tags: ["critical", "db", "resolved"],
    project_id: null,
    created_by_chat_id: "42",
    created_at: T_OPENED_2H,
    updated_at: T_RESOLVED_1H,
  },
  {
    id: 2,
    title: "Cron drift on host-2",
    symptom: "Hourly metrics scrape running 7 minutes late.",
    root_cause: null,
    resolution: null,
    tags: ["medium"],
    project_id: null,
    created_by_chat_id: null,
    created_at: T_OPENED_1D,
    updated_at: T_OPENED_1D,
  },
  {
    id: 3,
    title: "Auth service latency regression",
    symptom: "p99 latency on /login climbed from 180ms → 920ms after deploy.",
    root_cause: "New session-cookie middleware was hashing on every request.",
    resolution: null,
    tags: ["high", "auth"],
    project_id: null,
    created_by_chat_id: "73",
    created_at: T_OPENED_3D,
    updated_at: T_OPENED_3D,
  },
];

interface StubOpts {
  incidents?: IncidentSeed[];
  detailFor?: IncidentSeed;
  detailNotFound?: string;
}

/**
 * Stub every endpoint the incidents page hydrates off so the visual
 * baselines never drift with the backend's accumulated seed state.
 */
async function stubIncidentsEndpoints(
  page: Page,
  opts: StubOpts = {},
): Promise<void> {
  const incidents = opts.incidents ?? FIXTURE_INCIDENTS;
  const json = (o: unknown) => JSON.stringify(o);

  async function handleIncidentsList(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({
        items: incidents,
        total: incidents.length,
        offset: 0,
        limit: incidents.length || 50,
      }),
    });
  }

  async function handleIncidentDetail(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();

    const url = new URL(req.url());
    const segments = url.pathname.split("/");
    const tail = segments[segments.length - 1] ?? "";

    if (opts.detailNotFound && tail === opts.detailNotFound) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: json({ error: "Incident not found" }),
      });
      return;
    }

    const target =
      opts.detailFor && String(opts.detailFor.id) === tail
        ? opts.detailFor
        : incidents.find((i) => String(i.id) === tail);
    if (!target) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: json({ error: "Incident not found" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json(target),
    });
  }

  async function handleIncidentTags(route: Route) {
    const req = route.request();
    if (req.resourceType() === "document") return route.fallback();
    if (req.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({ tags: [] }),
    });
  }

  // The list endpoint matches `/incidents?…`; the detail endpoint matches
  // `/incidents/:id`. Order matters — `page.route` evaluates patterns in
  // registration order, so register the more specific tags + detail
  // handlers first.
  await page.route(/\/incidents\/tags(\?[^/]*)?$/, handleIncidentTags);
  await page.route(/\/incidents\/[^/?]+(\?[^/]*)?$/, handleIncidentDetail);
  await page.route(/\/incidents(\?[^/]*)?$/, handleIncidentsList);
}

// ---------------------------------------------------------------------------
// Behavioural specs
// ---------------------------------------------------------------------------

test("incidents page calls GET /incidents on load", async ({ page }) => {
  await stubIncidentsEndpoints(page);
  const listed = page.waitForResponse(
    (r) =>
      /\/incidents(\?|$)/.test(r.url()) &&
      r.request().method() === "GET" &&
      // The detail endpoint matches `/incidents/<id>` — exclude it so
      // the assertion lands on the list call only.
      !/\/incidents\/[^/?]+(\?|$)/.test(r.url()),
  );
  await page.goto("/incidents");
  const res = await listed;
  expect(res.status()).toBe(200);
});

test("incidents page row click navigates to /incidents/:id", async ({
  page,
}) => {
  await stubIncidentsEndpoints(page);
  await page.goto("/incidents");
  await expect(
    page.getByRole("heading", { name: "Incidents", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("incidents-table")).toBeVisible({
    timeout: 10_000,
  });

  const firstRow = page.getByTestId("incidents-table-row").first();
  await firstRow.click();
  await page.waitForURL(/\/incidents\/[^/?]+$/, { timeout: 10_000 });
  await expect(page.getByTestId("incident-detail-page")).toBeVisible({
    timeout: 10_000,
  });
});

// Negative test (per task spec): a 404 incident renders an error block
// with a back-link to the list.
test("404 incident renders error with back link", async ({ page }) => {
  await stubIncidentsEndpoints(page, { detailNotFound: "does-not-exist" });
  await page.goto("/incidents/does-not-exist");
  // The page mounts — the back link is the first thing the detail
  // page renders, so it stays visible even on the error branch.
  await expect(page.getByTestId("incident-detail-page")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Back to incidents/i }),
  ).toHaveAttribute("href", "/incidents");
  // The error block surfaces the failure with role=alert.
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Visual baselines (slice 25-04 T02).
// ---------------------------------------------------------------------------

test.describe("incidents page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`list layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await stubIncidentsEndpoints(page);

      await page.goto("/incidents");
      await expect(
        page
          .getByTestId("incidents-page")
          .getByRole("heading", { name: "Incidents", level: 1 }),
      ).toBeVisible();
      // Wait for the table + every body row before snapshotting.
      await expect(page.getByTestId("incidents-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("incidents-table-row")).toHaveCount(
        FIXTURE_INCIDENTS.length,
        { timeout: 10_000 },
      );

      await freeze(page);
      await expect(page).toHaveScreenshot(`incidents-list-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`empty state — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await stubIncidentsEndpoints(page, { incidents: [] });

      await page.goto("/incidents");
      await expect(
        page.getByRole("heading", { name: "Incidents", level: 1 }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("incidents-empty-state")).toBeVisible({
        timeout: 10_000,
      });

      await freeze(page);
      await expect(page).toHaveScreenshot(`incidents-empty-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`detail layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      // First fixture is the resolved-critical incident — it has
      // every long-text field filled, so the detail layout (header
      // pill + body sections + timeline) renders with no holes.
      const target = FIXTURE_INCIDENTS[0]!;
      await stubIncidentsEndpoints(page, { detailFor: target });

      await page.goto(`/incidents/${target.id}`);
      await expect(page.getByTestId("incident-detail-page")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("incident-detail-severity")).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        page.getByTestId("incident-detail-timeline-section"),
      ).toBeVisible({ timeout: 10_000 });

      await freeze(page);
      await expect(page).toHaveScreenshot(`incidents-detail-${theme}.png`, {
        fullPage: true,
        threshold: 0.1,
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
