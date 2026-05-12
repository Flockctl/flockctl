import { test, expect, type Route } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the BranchPicker combobox + the create / delete dialogs that
 * hang off it.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`) with
 * no `.git/` dir, so `GET /projects/:id/git-branches` and the matching
 * mutation routes would otherwise return `not_a_repo`. We stub each
 * route per-test to drive the visible branches.
 *
 * Each test guards on `code-mode-root` visibility — the BranchPicker is
 * mounted inside the SCM panel header (which only renders inside Code
 * mode). When CodeMode is not yet wired into project-detail (e.g. on a
 * future surface migration) the test skips rather than fails so the
 * spec is safe to land alongside the component itself.
 *
 * Visual baselines live in
 *   `ui/e2e/__screenshots__/branches.spec.ts/`
 * per the playwright `snapshotPathTemplate`. Regenerate with:
 *   npm run e2e:update -- branches
 */

interface StubBranch {
  name: string;
  current?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  isRemote?: boolean;
}

function stubBranchListRoute(
  page: import("@playwright/test").Page,
  projectId: number,
  branches: StubBranch[],
) {
  return page.route(`**/projects/${projectId}/git-branches`, (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        detached: false,
        branches: branches.map((b) => ({
          name: b.name,
          current: b.current ?? false,
          upstream: b.upstream ?? null,
          ahead: b.ahead ?? 0,
          behind: b.behind ?? 0,
          isRemote: b.isRemote ?? false,
        })),
        reason: "ok",
      }),
    });
  });
}

async function openScmPanelAndPicker(
  page: import("@playwright/test").Page,
  projectId: number,
) {
  await page.goto(`/projects/${projectId}`);
  const root = page.getByTestId("code-mode-root");
  test.skip(
    !(await root.isVisible().catch(() => false)),
    "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
  );
  await page.getByTestId("code-mode-tab-scm").click();
  await expect(page.getByTestId("scm-panel")).toBeVisible();
  await expect(page.getByTestId("branch-picker-trigger")).toBeVisible();
}

test.describe("BranchPicker", () => {
  test("renders the current branch and opens the popover", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feature/foo" },
      { name: "feature/bar" },
      { name: "origin/main", isRemote: true },
    ]);
    await openScmPanelAndPicker(page, proj.id);

    await expect(page.getByTestId("branch-picker-current")).toHaveText("main");
    await page.getByTestId("branch-picker-trigger").click();

    await expect(page.getByTestId("branch-picker-popover")).toBeVisible();
    const list = page.getByTestId("branch-picker-list");
    await expect(list.getByTestId("branch-picker-item-main")).toBeVisible();
    await expect(list.getByTestId("branch-picker-item-feature/foo")).toBeVisible();
    await expect(list.getByTestId("branch-picker-item-feature/bar")).toBeVisible();
    // Remote refs filtered out — only local branches show in the picker.
    await expect(list.getByTestId("branch-picker-item-origin/main")).toHaveCount(0);
  });

  test("filter input narrows the list and renders empty-state on no match", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-filter"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true },
      { name: "feature/foo" },
      { name: "feature/bar" },
    ]);
    await openScmPanelAndPicker(page, proj.id);
    await page.getByTestId("branch-picker-trigger").click();

    const filter = page.getByTestId("branch-picker-filter");
    await filter.fill("foo");
    const list = page.getByTestId("branch-picker-list");
    await expect(list.getByTestId("branch-picker-item-feature/foo")).toBeVisible();
    await expect(list.getByTestId("branch-picker-item-feature/bar")).toHaveCount(0);

    await filter.fill("zzz-no-match");
    await expect(page.getByTestId("branch-picker-empty")).toBeVisible();
  });

  test("clicking a branch fires checkout; dirty tree surfaces a toast", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-checkout"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true },
      { name: "feature/foo" },
    ]);
    // Drive the dirty-tree failure path. The server returns HTTP 200 with
    // `ok:false, reason:'dirty_working_tree'` — same wire shape every
    // structured failure uses.
    await page.route(`**/projects/${proj.id}/git-checkout`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          branch: "feature/foo",
          reason: "dirty_working_tree",
          message:
            "Working tree has uncommitted changes (3 files). Commit, stash, or discard them before switching branches.",
        }),
      }),
    );

    await openScmPanelAndPicker(page, proj.id);
    await page.getByTestId("branch-picker-trigger").click();

    const row = page.getByTestId("branch-picker-item-feature/foo");
    await row.getByText("feature/foo").click();

    // The popover closes and the toast region carries the error.
    await expect(page.getByTestId("branch-picker-popover")).toHaveCount(0);
    const toast = page.getByTestId("scm-toast-error");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/uncommitted changes/i);
  });

  test("create dialog: 'from <currentBranch>' hint + invalid name disables Create", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-create"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true },
    ]);
    await openScmPanelAndPicker(page, proj.id);
    await page.getByTestId("branch-picker-trigger").click();
    await page.getByTestId("branch-picker-create").click();

    await expect(page.getByTestId("branch-create-dialog")).toBeVisible();
    await expect(page.getByTestId("branch-create-from")).toContainText("main");

    const submit = page.getByTestId("branch-create-submit");
    await expect(submit).toBeDisabled();

    // Spaces violate the public branch-name regex.
    await page.getByTestId("branch-create-name").fill("bad name");
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId("branch-create-error")).toBeVisible();

    await page.getByTestId("branch-create-name").fill("feature/x");
    await expect(submit).toBeEnabled();
  });

  test("delete dialog: protected branch surfaces hint + force gate", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-delete"));
    // `feature/foo` is current so `main` is deletable in principle.
    await stubBranchListRoute(page, proj.id, [
      { name: "feature/foo", current: true },
      { name: "main" },
    ]);
    await openScmPanelAndPicker(page, proj.id);
    await page.getByTestId("branch-picker-trigger").click();
    await page.getByTestId("branch-picker-manage").click();
    await page.getByTestId("branch-picker-delete-main").click();

    const dialog = page.getByTestId("branch-delete-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("branch-delete-name")).toHaveText("main");
    await expect(dialog.getByTestId("branch-delete-protected-hint")).toBeVisible();
    await expect(dialog.getByTestId("branch-delete-audit-hint")).toBeVisible();

    const submit = dialog.getByTestId("branch-delete-submit");
    // Protected branch + force unchecked → submit disabled.
    await expect(submit).toBeDisabled();
    await dialog.getByTestId("branch-delete-force-checkbox").click();
    await expect(submit).toBeEnabled();
  });

  test("branch-picker-open: visual baseline (popover open)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-snap-open"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feature/foo" },
      { name: "feature/bar" },
    ]);
    await openScmPanelAndPicker(page, proj.id);
    // Force the light theme so the baseline is deterministic.
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });
    await page.getByTestId("branch-picker-trigger").click();
    await expect(page.getByTestId("branch-picker-popover")).toBeVisible();
    // Freeze animations so the snapshot doesn't drift.
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; }",
    });
    await expect(page.getByTestId("branch-picker-popover")).toHaveScreenshot(
      "branch-picker-open.png",
    );
  });

  test("branch-create-input: visual baseline (create dialog with valid name)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("branches-snap-create"));
    await stubBranchListRoute(page, proj.id, [
      { name: "main", current: true },
    ]);
    await openScmPanelAndPicker(page, proj.id);
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });
    await page.getByTestId("branch-picker-trigger").click();
    await page.getByTestId("branch-picker-create").click();
    await page.getByTestId("branch-create-name").fill("feature/new-thing");
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
    });
    await expect(page.getByTestId("branch-create-dialog")).toHaveScreenshot(
      "branch-create-input.png",
    );
  });
});
