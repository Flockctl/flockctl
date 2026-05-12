import { test, expect } from "@playwright/test";
import { createWorkspace, uniq } from "./_helpers";

/**
 * Visual + interaction baselines for the workspace-detail Git dropdown.
 *
 * The dropdown is the same component as on project-detail —
 * `<GitDropdownButton target={{ kind: 'workspace', … }}>` — so the
 * test-id contract on the trigger and menu items is reused verbatim
 * (`project-detail-page-git-button`, `project-detail-page-git-pull`,
 * etc.). The value of this spec is in:
 *
 *   1. The dropdown actually mounts on the workspace surface and the
 *      trigger is reachable from the workspace-detail header
 *      (`workspace-dropdown-default` baseline).
 *   2. Opening the dropdown reveals the same Pull / Commit… / Push…
 *      menu items as on project-detail.
 *   3. The Push dialog opens via the workspace-mounted dropdown and
 *      its summary section renders (same as on project-detail).
 *
 * The seeded workspace's path is a stub (`/tmp/<name>`) with no
 * `.git/` dir on the test backend, so we do NOT submit any of the
 * dialogs — the visual assertion is the value here, not a real git
 * round-trip.
 */

test.describe("workspace-detail Git dropdown — baselines", () => {
  test("workspace-dropdown-default: trigger visible in header, menu opens with Pull/Commit/Push", async ({
    page,
    request,
  }) => {
    const ws = await createWorkspace(request, uniq("git-ws"));
    await page.goto(`/workspaces/${ws.id}`);

    const trigger = page.getByTestId("project-detail-page-git-button");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    // The trigger is enabled because the seed helper assigns a path.
    await expect(trigger).toBeEnabled();
    await trigger.click();

    // Same test-ids as on the project surface — the component is
    // shared.
    await expect(
      page.getByTestId("project-detail-page-git-pull"),
    ).toBeVisible();
    await expect(
      page.getByTestId("project-detail-page-git-commit"),
    ).toBeVisible();
    await expect(
      page.getByTestId("project-detail-page-git-push"),
    ).toBeVisible();
  });

  test("workspace-push-dialog-default: Push… opens the production push dialog", async ({
    page,
    request,
  }) => {
    const ws = await createWorkspace(request, uniq("git-ws-push"));
    await page.goto(`/workspaces/${ws.id}`);

    await page.getByTestId("project-detail-page-git-button").click();
    await page.getByTestId("project-detail-page-git-push").click();

    const dialog = page.getByTestId("git-push-dialog");
    await expect(dialog).toBeVisible();
    // Advanced collapsed by default — same shape as on project-detail.
    await expect(
      page.getByTestId("git-push-dialog-advanced"),
    ).not.toHaveAttribute("open", /.*/);

    await expect(dialog).toHaveScreenshot(
      "workspace-push-dialog-default.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("workspace-commit-dialog-default: Commit… opens the production commit dialog", async ({
    page,
    request,
  }) => {
    const ws = await createWorkspace(request, uniq("git-ws-commit"));

    // Stub the porcelain peek — the test workspace path has no .git/
    // dir on the daemon, so we'd otherwise get `not_a_repo` and the
    // dialog body would render the failure state instead of the
    // checkbox checklist we want to baseline.
    await page.route(`**/workspaces/${ws.id}/git-status`, (route) =>
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

    await page.goto(`/workspaces/${ws.id}`);

    await page.getByTestId("project-detail-page-git-button").click();
    await page.getByTestId("project-detail-page-git-commit").click();

    const dialog = page.getByTestId("git-commit-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByTestId("git-commit-row-src/foo.ts"),
    ).toBeVisible();
    await expect(
      page.getByTestId("git-commit-row-src/bar.ts"),
    ).toBeVisible();
    // Pre-checked on first arrival — same UX as project surface.
    await expect(
      page.getByTestId("git-commit-row-src/foo.ts").getByRole("checkbox"),
    ).toBeChecked();
    // Submit gated on a non-empty message.
    await expect(page.getByTestId("git-commit-submit")).toBeDisabled();
    await page
      .getByTestId("git-commit-message")
      .fill("feat: workspace commit");
    await expect(page.getByTestId("git-commit-submit")).toBeEnabled();

    await expect(dialog).toHaveScreenshot(
      "workspace-commit-dialog-default.png",
      { maxDiffPixelRatio: 0.02 },
    );
  });

  test("workspace-dropdown-disabled-no-path: trigger disabled with workspace-specific tooltip", async ({
    page,
    request,
  }) => {
    // Create a workspace then patch it to clear `path`. The seed
    // helper insists on a `/tmp/<name>` path; the disabled tooltip
    // contract only kicks in when the path is empty.
    const ws = await createWorkspace(request, uniq("git-ws-nopath"));
    const patch = await request.patch(`/workspaces/${ws.id}`, {
      data: { path: "" },
    });
    // Some daemon builds reject empty path with 422; in that case we
    // skip the test because there is no way to put the UI into the
    // disabled-tooltip state from the API. The test-id assertion in
    // the unit tests covers the same contract at the component level.
    test.skip(
      patch.status() !== 200,
      `daemon refused empty workspace path (${patch.status()}) — disabled-tooltip path unreachable from e2e`,
    );

    // The current PATCH /workspaces/:id handler whitelists the fields
    // it copies into the update set (name, description, repoUrl,
    // allowedKeyIds, gitignore* …) and `path` is NOT one of them — so
    // a 200 response does NOT mean the path was actually cleared.
    // Re-fetch and skip if the path is still set; the component-level
    // test covers the disabled-tooltip contract directly.
    const updated = await (
      await request.get(`/workspaces/${ws.id}`)
    ).json();
    test.skip(
      typeof updated?.path === "string" && updated.path.length > 0,
      `daemon ignored path:"" PATCH (path still ${JSON.stringify(updated?.path)}) — disabled-tooltip path unreachable from e2e`,
    );

    await page.goto(`/workspaces/${ws.id}`);
    const trigger = page.getByTestId("project-detail-page-git-button");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveAttribute(
      "title",
      /no git repository attached/i,
    );
  });
});
