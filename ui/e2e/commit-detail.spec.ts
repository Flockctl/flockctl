import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the commit-detail tab.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`) with
 * no `.git/` dir, so the real `runGitShow` would return `not_a_repo`.
 * We stub `/git-show` and `/git-diff` per-test to drive each branch:
 *
 *   - Header renders the subject + short-sha + author from `git-show`.
 *   - File list shows one row per file with status + counts.
 *   - First file is auto-selected; the diff editor wrapper appears.
 *   - Clicking a different file fires a fresh `/git-diff` request with
 *     the new path and `base=<sha>~1`.
 *   - Initial commit (parents=[]) uses the empty-tree SHA as the diff
 *     base instead of `<sha>~1`.
 *   - Empty file list renders the empty-state notice.
 */

const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const PARENT_SHA = "1111111111111111111111111111111111111111";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function tsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

test.describe("Commit-detail tab", () => {
  test("renders header + file list and auto-selects the first file", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("commit-detail"));

    await page.route(`**/projects/${proj.id}/git-show**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commit: {
            sha: HEAD_SHA,
            parents: [PARENT_SHA],
            author: "Eduard",
            email: "ed@example.com",
            ts: tsAgo(120),
            message: "feat: ship commit-detail tab",
          },
          files: [
            { path: "src/foo.ts", status: "M", added: 5, removed: 2 },
            { path: "src/bar.ts", status: "A", added: 12, removed: 0 },
          ],
          reason: "ok",
        }),
      }),
    );

    let lastDiffParams: Record<string, string> | null = null;
    await page.route(`**/projects/${proj.id}/git-diff**`, (route, request) => {
      const url = new URL(request.url());
      lastDiffParams = Object.fromEntries(url.searchParams.entries());
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          patch: "@@ -1 +1 @@\n-old line\n+new line\n",
          base: `${HEAD_SHA}~1`,
          head: HEAD_SHA,
          status: "M",
          size: 42,
          reason: "ok",
        }),
      });
    });

    await page.goto(`/projects/${proj.id}/git/commit/${HEAD_SHA}`);

    await expect(page.getByTestId("commit-detail-tab")).toBeVisible();
    await expect(page.getByTestId("commit-detail-header")).toContainText(
      "feat: ship commit-detail tab",
    );
    await expect(page.getByTestId("commit-detail-sha")).toHaveText("abcdef0");

    // File list is populated.
    await expect(page.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-path",
      "src/foo.ts",
    );
    await expect(page.getByTestId("commit-detail-file-1")).toHaveAttribute(
      "data-path",
      "src/bar.ts",
    );

    // Auto-selected first file → diff editor mounts.
    await expect(page.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("commit-detail-diff")).toBeVisible();
    await expect(page.getByTestId("commit-detail-diff")).toHaveAttribute(
      "data-path",
      "src/foo.ts",
    );

    // First diff fetch hit `base=<sha>~1`, not the empty-tree SHA, since
    // the commit has a parent.
    await expect.poll(() => lastDiffParams).not.toBeNull();
    expect(lastDiffParams).toMatchObject({
      path: "src/foo.ts",
      base: `${HEAD_SHA}~1`,
      head: HEAD_SHA,
    });
  });

  test("clicking a different file fires a fresh git-diff with the new path", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("commit-detail-click"));

    await page.route(`**/projects/${proj.id}/git-show**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commit: {
            sha: HEAD_SHA,
            parents: [PARENT_SHA],
            author: "Eduard",
            email: "ed@example.com",
            ts: tsAgo(60),
            message: "two files",
          },
          files: [
            { path: "src/foo.ts", status: "M", added: 5, removed: 2 },
            { path: "src/bar.ts", status: "A", added: 12, removed: 0 },
          ],
          reason: "ok",
        }),
      }),
    );

    const diffPaths: string[] = [];
    await page.route(`**/projects/${proj.id}/git-diff**`, (route, request) => {
      const url = new URL(request.url());
      const p = url.searchParams.get("path") ?? "";
      diffPaths.push(p);
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          patch: `diff for ${p}`,
          base: `${HEAD_SHA}~1`,
          head: HEAD_SHA,
          status: "M",
          size: 16,
          reason: "ok",
        }),
      });
    });

    await page.goto(`/projects/${proj.id}/git/commit/${HEAD_SHA}`);
    await expect(page.getByTestId("commit-detail-tab")).toBeVisible();

    // Auto-fetched the first file.
    await expect.poll(() => diffPaths).toContain("src/foo.ts");

    // Click the second file → second fetch fires with the new path.
    await page.getByTestId("commit-detail-file-1").click();

    await expect.poll(() => diffPaths).toContain("src/bar.ts");
    await expect(page.getByTestId("commit-detail-file-1")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("uses the empty-tree SHA as base for the initial commit (parents=[])", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("commit-detail-initial"));

    await page.route(`**/projects/${proj.id}/git-show**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commit: {
            sha: HEAD_SHA,
            parents: [],
            author: "Eduard",
            email: "ed@example.com",
            ts: tsAgo(3600),
            message: "initial commit",
          },
          files: [{ path: "README.md", status: "A", added: 1, removed: 0 }],
          reason: "ok",
        }),
      }),
    );

    let lastBase: string | null = null;
    await page.route(`**/projects/${proj.id}/git-diff**`, (route, request) => {
      const url = new URL(request.url());
      lastBase = url.searchParams.get("base");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          patch: "@@ -0,0 +1 @@\n+# README\n",
          base: EMPTY_TREE,
          head: HEAD_SHA,
          status: "A",
          size: 24,
          reason: "ok",
        }),
      });
    });

    await page.goto(`/projects/${proj.id}/git/commit/${HEAD_SHA}`);
    await expect(page.getByTestId("commit-detail-tab")).toBeVisible();

    await expect.poll(() => lastBase).toBe(EMPTY_TREE);
  });

  test("renders the empty-files notice when files=[]", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("commit-detail-empty"));

    await page.route(`**/projects/${proj.id}/git-show**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          commit: {
            sha: HEAD_SHA,
            parents: [PARENT_SHA],
            author: "Eduard",
            email: "ed@example.com",
            ts: tsAgo(30),
            message: "empty commit",
          },
          files: [],
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}/git/commit/${HEAD_SHA}`);

    await expect(page.getByTestId("commit-detail-tab")).toBeVisible();
    await expect(
      page.getByTestId("commit-detail-file-empty"),
    ).toBeVisible();
    await expect(page.getByTestId("commit-detail-empty")).toBeVisible();
  });

  test("renders an error state when git-show fails with bad_revision", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("commit-detail-err"));

    await page.route(`**/projects/${proj.id}/git-show**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          reason: "bad_revision",
          message: "unknown revision",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}/git/commit/${HEAD_SHA}`);
    const err = page.getByTestId("commit-detail-error");
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute("data-reason", "bad_revision");
  });
});
