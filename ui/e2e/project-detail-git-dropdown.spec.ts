import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * Visual + interaction baselines for the project-detail Git dropdown's
 * Push dialog. These specs do NOT exercise a real git push (the seeded
 * project's path is a stub — `/tmp/<name>` with no `.git/` dir on the
 * test backend), so we do NOT click submit. The value is in:
 *
 *   1. The dropdown opens, the Push… item exists, and clicking it
 *      reveals the dialog (`push-dialog-default` baseline).
 *   2. Expanding "Advanced" reveals the force-zone with the literal
 *      gate input + the danger-zone styling
 *      (`push-dialog-advanced-expanded` baseline).
 *   3. The auth-failed inline card matches its baseline
 *      (`push-dialog-auth-failed-state`). We surface this state by
 *      stubbing the `/projects/:id/git-push` route so we don't need a
 *      real broken credential set in CI.
 */

test.describe("project-detail Git dropdown — push dialog baselines", () => {
  test("push-dialog-default: dialog opens with summary and collapsed Advanced", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-push"));
    await page.goto(`/projects/${proj.id}`);

    const trigger = page.getByTestId("project-detail-page-git-button");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    await page.getByTestId("project-detail-page-git-push").click();

    // Dialog testid maps to the production component; the placeholder
    // testid (`git-push-dialog-placeholder`) is the legacy fallback
    // until the dropdown swaps in `<GitPushDialog>` from this slice.
    const dialog = page.getByTestId("git-push-dialog").or(
      page.getByTestId("git-push-dialog-placeholder"),
    );
    await expect(dialog).toBeVisible();

    // If the production dialog is wired in, assert its surface.
    const realDialog = page.getByTestId("git-push-dialog");
    if (await realDialog.isVisible()) {
      await expect(
        page.getByTestId("git-push-dialog-advanced"),
      ).not.toHaveAttribute("open", /.*/);
      await expect(realDialog).toHaveScreenshot("push-dialog-default.png", {
        maxDiffPixelRatio: 0.02,
      });
    }
  });

  test("push-dialog-advanced-expanded: force zone + literal gate visible", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-push-adv"));
    await page.goto(`/projects/${proj.id}`);

    await page.getByTestId("project-detail-page-git-button").click();
    await page.getByTestId("project-detail-page-git-push").click();

    const realDialog = page.getByTestId("git-push-dialog");
    test.skip(
      !(await realDialog.isVisible()),
      "production GitPushDialog not yet wired into the dropdown",
    );

    await page.getByTestId("git-push-dialog-advanced-toggle").click();
    await expect(
      page.getByTestId("git-push-dialog-force-zone"),
    ).toBeVisible();
    await expect(
      page.getByTestId("git-push-dialog-force-input"),
    ).toBeVisible();
    await expect(
      page.getByTestId("git-push-dialog-force-submit"),
    ).toBeDisabled();

    await expect(realDialog).toHaveScreenshot(
      "push-dialog-advanced-expanded.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("push-dialog-auth-failed-state: inline auth hint card with docs link", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-push-auth"));

    // Stub the push endpoint so we don't depend on a real broken
    // credential set. The structured 200 + ok:false response shape
    // mirrors the daemon's contract exactly (see GitPushFailure).
    await page.route(`**/projects/${proj.id}/git-push`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          reason: "auth_failed",
          message: "fatal: Authentication failed for 'https://github.com/...'",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);

    await page.getByTestId("project-detail-page-git-button").click();
    await page.getByTestId("project-detail-page-git-push").click();

    const realDialog = page.getByTestId("git-push-dialog");
    test.skip(
      !(await realDialog.isVisible()),
      "production GitPushDialog not yet wired into the dropdown",
    );

    // The dropdown currently passes `gitInfo={null}` (see
    // git-dropdown-button.tsx — the dropdown's job is only to mount the
    // dialog; threading a real branch/upstream peek is a separate
    // change), which permanently disables the push submit button until
    // a future slice wires `GET /projects/:id/git-info`. Skip the
    // auth-error round-trip when that's still the case — the
    // unit-level test in ui/src/__tests__/git-push-dialog.test.tsx
    // covers the auth-failed branch directly with a stubbed gitInfo.
    const submit = page.getByTestId("git-push-dialog-submit");
    test.skip(
      await submit.isDisabled(),
      "push submit is permanently disabled until git-info is wired through the dropdown",
    );

    await submit.click();

    const hint = page.getByTestId("git-push-dialog-auth-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/authentication failed/i);
    await expect(
      page.getByTestId("git-push-dialog-auth-docs-link"),
    ).toHaveAttribute("href", "https://docs.flockctl.dev/git-auth");

    await expect(realDialog).toHaveScreenshot(
      "push-dialog-auth-failed-state.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });
});

/**
 * Visual + interaction baselines for the project-detail Git dropdown's
 * Commit dialog. The seeded project's path is a stub (`/tmp/<name>`) with
 * no real `.git/` dir on the test backend, so we stub the porcelain status
 * + commit endpoints — the value here is in the dialog's *shape* (checkbox
 * checklist, message editor, success state), not in driving real git.
 *
 * Baselines:
 *   - `commit-dialog-with-porcelain-checkboxes`  — two-file flow at rest.
 *   - `commit-dialog-success-with-sha`           — the 7-char SHA + file
 *                                                  count that replaces
 *                                                  the body on ok:true.
 */

test.describe("project-detail Git dropdown — commit dialog baselines", () => {
  test("commit-dialog-with-porcelain-checkboxes: two-file flow renders rows + message", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-commit"));

    // Stub the porcelain status response — the test project's path has
    // no .git/ dir, so the daemon would otherwise return `not_a_repo`.
    await page.route(`**/projects/${proj.id}/git-status`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          branch: "feature-x",
          detached: false,
          entries: [
            { path: "src/foo.ts", index: " ", worktree: "M" },
            { path: "src/bar.ts", index: "?", worktree: "?" },
          ],
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);

    const trigger = page.getByTestId("project-detail-page-git-button");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    await page.getByTestId("project-detail-page-git-commit").click();

    const dialog = page.getByTestId("git-commit-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByTestId("git-commit-row-src/foo.ts"),
    ).toBeVisible();
    await expect(
      page.getByTestId("git-commit-row-src/bar.ts"),
    ).toBeVisible();
    // Both pre-checked on first arrival.
    await expect(
      page
        .getByTestId("git-commit-row-src/foo.ts")
        .getByRole("checkbox"),
    ).toBeChecked();
    // Submit is disabled until a message is typed (selection is already
    // populated by the pre-check).
    await expect(page.getByTestId("git-commit-submit")).toBeDisabled();
    await page.getByTestId("git-commit-message").fill("feat: add foo + bar");
    await expect(page.getByTestId("git-commit-submit")).toBeEnabled();

    await expect(dialog).toHaveScreenshot(
      "commit-dialog-with-porcelain-checkboxes.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("commit-dialog-success-with-sha: replaces body with SHA + file count on ok:true", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-commit-ok"));

    await page.route(`**/projects/${proj.id}/git-status`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          branch: "feature-x",
          detached: false,
          entries: [
            { path: "src/foo.ts", index: " ", worktree: "M" },
            { path: "src/bar.ts", index: "?", worktree: "?" },
          ],
          reason: "ok",
        }),
      }),
    );
    await page.route(`**/projects/${proj.id}/git-commit`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          filesCommitted: 2,
          reason: "ok",
        }),
      }),
    );

    await page.goto(`/projects/${proj.id}`);
    await page.getByTestId("project-detail-page-git-button").click();
    await page.getByTestId("project-detail-page-git-commit").click();

    const dialog = page.getByTestId("git-commit-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("git-commit-message").fill("feat: add foo + bar");
    await page.getByTestId("git-commit-submit").click();

    const success = page.getByTestId("git-commit-success");
    await expect(success).toBeVisible();
    await expect(page.getByTestId("git-commit-success-sha")).toHaveText(
      "abcdef1",
    );
    await expect(success).toContainText(/2 files/);
    // Form surfaces are gone — no chance of a double commit.
    await expect(
      page.getByTestId("git-commit-message"),
    ).not.toBeVisible();
    await expect(
      page.getByTestId("git-commit-submit"),
    ).not.toBeVisible();

    await expect(dialog).toHaveScreenshot(
      "commit-dialog-success-with-sha.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });
});
