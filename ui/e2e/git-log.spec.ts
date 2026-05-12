import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the SCM panel's History list.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`) with
 * no `.git/` dir, so `GET /projects/:id/git-log` would otherwise return
 * `not_a_repo`. We stub the route per-test to drive each branch:
 *
 *   - Default-collapsed: section starts closed; clicking the toggle
 *     opens it and triggers the first-page fetch.
 *   - Row shape: short-sha + subject + author + relative-time, with the
 *     subject's `title` carrying the full text.
 *   - Load-more: visible while `next_cursor` is non-null; clicking it
 *     advances and the next page's rows append to the list.
 *   - Empty repo: `commits: []` renders the empty-state copy.
 *   - localStorage persistence: a reload restores the section's state.
 *   - Click row → URL changes to `/projects/:id/git/commit/:sha` (slice 01
 *     owns the destination view; we only assert the routing call).
 *
 * Visual baseline (light theme) lives at
 *   `ui/e2e/__screenshots__/git-log.spec.ts/history-list.png`
 * via the global `snapshotPathTemplate` in `playwright.config.ts`.
 */

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

function tsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

test.describe("SCM History list", () => {
  test("default collapsed; clicking the toggle expands and renders rows", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-log"));

    await page.route(`**/projects/${proj.id}/git-log**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [
            {
              sha: SHA1,
              shortSha: SHA1.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(120),
              subject: "feat: add HistoryList",
              parents: [],
            },
            {
              sha: SHA2,
              shortSha: SHA2.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(7200),
              subject: "fix: typo in README",
              parents: [SHA1],
            },
          ],
          nextCursor: null,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();

    // The body is not in the DOM until the user expands it.
    await expect(page.getByTestId("scm-history-toggle")).toBeVisible();
    await expect(page.getByTestId("scm-history")).toHaveCount(0);

    await page.getByTestId("scm-history-toggle").click();
    await expect(page.getByTestId("scm-history")).toBeVisible();

    const list = page.getByTestId("scm-history-list");
    await expect(list.getByTestId(`scm-history-row-${SHA1}`)).toBeVisible();
    await expect(list.getByTestId(`scm-history-row-${SHA2}`)).toBeVisible();
    await expect(
      list.getByTestId(`scm-history-sha-${SHA1}`),
    ).toHaveText("aaaaaaa");
    await expect(
      list.getByTestId(`scm-history-subject-${SHA1}`),
    ).toHaveText("feat: add HistoryList");
    // Tooltip carries the full subject — assert via the title attribute.
    await expect(
      list.getByTestId(`scm-history-subject-${SHA1}`),
    ).toHaveAttribute("title", "feat: add HistoryList");
  });

  test("Load-more advances the list when next_cursor is non-null", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-log-paged"));

    let pageNum = 0;
    await page.route(`**/projects/${proj.id}/git-log**`, (route) => {
      pageNum += 1;
      if (pageNum === 1) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            commits: [
              {
                sha: SHA1,
                shortSha: SHA1.slice(0, 7),
                author: "Eduard",
                email: "ed@example.com",
                ts: tsAgo(60),
                subject: "page-1 commit",
                parents: [],
              },
            ],
            nextCursor: SHA2,
            reason: "ok",
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [
            {
              sha: SHA3,
              shortSha: SHA3.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(7200),
              subject: "page-2 commit",
              parents: [SHA1],
            },
          ],
          nextCursor: null,
          reason: "ok",
        }),
      });
    });

    await page.goto(`/projects/${proj.id}`);
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await page.getByTestId("scm-history-toggle").click();

    await expect(
      page.getByTestId(`scm-history-row-${SHA1}`),
    ).toBeVisible();
    await expect(page.getByTestId("scm-history-load-more")).toBeVisible();

    await page.getByTestId("scm-history-load-more").click();

    // After the second page resolves, both rows are in the list and the
    // load-more button vanishes (next_cursor became null).
    await expect(
      page.getByTestId(`scm-history-row-${SHA3}`),
    ).toBeVisible();
    await expect(page.getByTestId("scm-history-load-more")).toHaveCount(0);
  });

  test("empty repo → 'No commits yet.' notice", async ({ page, request }) => {
    const proj = await createProject(request, uniq("git-log-empty"));

    await page.route(`**/projects/${proj.id}/git-log**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [],
          nextCursor: null,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await page.getByTestId("scm-history-toggle").click();
    await expect(page.getByTestId("scm-history-empty")).toBeVisible();
    await expect(page.getByTestId("scm-history-list")).toHaveCount(0);
  });

  test("expansion state persists across reloads via localStorage", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-log-persist"));

    await page.route(`**/projects/${proj.id}/git-log**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [
            {
              sha: SHA1,
              shortSha: SHA1.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(60),
              subject: "persisted commit",
              parents: [],
            },
          ],
          nextCursor: null,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await page.getByTestId("scm-history-toggle").click();
    await expect(page.getByTestId("scm-history")).toBeVisible();

    // Reload — the localStorage flag should pre-open the section.
    await page.reload();
    await page.getByTestId("code-mode-tab-scm").click();
    await expect(page.getByTestId("scm-history")).toBeVisible();
  });

  test("clicking a row navigates to the commit-detail URL (slice 01)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-log-nav"));

    await page.route(`**/projects/${proj.id}/git-log**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [
            {
              sha: SHA1,
              shortSha: SHA1.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(60),
              subject: "click-me",
              parents: [],
            },
          ],
          nextCursor: null,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await page.getByTestId("scm-history-toggle").click();
    await page.getByTestId(`scm-history-row-${SHA1}`).click();

    // Slice 01 owns the destination route; we only assert the URL the
    // History list dispatched. A 404 / placeholder content there is a
    // slice-01 concern, not ours.
    await expect(page).toHaveURL(
      new RegExp(`/projects/${proj.id}/git/commit/${SHA1}$`),
    );
  });

  test("history-list visual baseline (light theme)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-log-snap"));

    await page.route(`**/projects/${proj.id}/git-log**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commits: [
            {
              sha: SHA1,
              shortSha: SHA1.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(7200),
              subject: "feat: ship the history list",
              parents: [],
            },
            {
              sha: SHA2,
              shortSha: SHA2.slice(0, 7),
              author: "Eduard",
              email: "ed@example.com",
              ts: tsAgo(86400),
              subject: "chore: bump deps",
              parents: [SHA1],
            },
          ],
          nextCursor: null,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    await page.getByTestId("code-mode-tab-scm").click();
    await page.getByTestId("scm-history-toggle").click();
    const history = page.getByTestId("scm-history");
    await expect(history).toBeVisible();

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    await expect(history).toHaveScreenshot("history-list.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
