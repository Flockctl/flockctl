import { test, expect } from "@playwright/test";

import { createProject, uniq } from "./_helpers";

/**
 * E2E for the source-control rail's Stash button (header) + Stashes
 * collapsible section (between Changes and History).
 *
 * Backend setup: the seeded e2e backend's project paths are stubs
 * (`/tmp/<name>`) with no `.git/` dir, so the stash-list endpoint returns
 * `not_a_repo` rather than a stash array. That means we cannot exercise
 * a real push → list → pop round-trip end-to-end here. What we CAN
 * exercise (and what this spec covers):
 *
 *   1. The Stash button is rendered in the SCM header next to Fetch
 *      and is keyboard-reachable.
 *   2. The Stashes section toggles open and closed; on the stubbed
 *      backend it surfaces either `scm-stash-empty` (when the path
 *      somehow resolves to a clean repo) or `scm-stash-error` (the
 *      dominant case for non-repo stub paths). Either is fine — both
 *      states satisfy "section renders something deterministic".
 *   3. Clicking the Stash button opens the {@link StashPushDialog};
 *      cancelling closes it without firing a mutation.
 *   4. Visual baselines for empty / populated / pop-confirm states are
 *      reserved at the paths the slice contract pins:
 *        - stash-list-empty.png
 *        - stash-list-populated.png
 *        - stash-confirm-pop.png
 *      The empty baseline is captured against the live (stub) backend.
 *      The populated + confirm-pop baselines need a deterministic mount
 *      path (a future dev preview route or a backend that seeds a real
 *      repo) — we leave those `test.skip` until one lands, and pin the
 *      snapshot paths so a future slice can flip the skip without
 *      reshaping the directory.
 */

test.describe("source-control stash UI", () => {
  test("Stash button is rendered in the SCM header next to Fetch", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-stash"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await expect(page.getByTestId("scm-panel")).toBeVisible();

    const stashBtn = page.getByTestId("scm-stash-push");
    const fetchBtn = page.getByTestId("scm-fetch");
    await expect(stashBtn).toBeVisible();
    await expect(fetchBtn).toBeVisible();

    // Both buttons sit in the SCM header row — same parent — so the
    // adjacency assertion is a sanity check, not a layout contract.
    const sameHeader = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="scm-stash-push"]');
      const f = document.querySelector('[data-testid="scm-fetch"]');
      return Boolean(s && f && s.parentElement === f.parentElement);
    });
    expect(sameHeader).toBe(true);

    // Keyboard reachability — focus via the accessibility tree.
    await stashBtn.focus();
    await expect(stashBtn).toBeFocused();
  });

  test("Stashes section toggles open + renders a deterministic body", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-stash-section"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await expect(page.getByTestId("scm-panel")).toBeVisible();

    const toggle = page.getByTestId("scm-stash-toggle");
    await expect(toggle).toBeVisible();

    // Default collapsed — the body should not be present.
    await expect(page.getByTestId("scm-stash")).toHaveCount(0);

    // Click to expand. The section is between Changes and History and
    // sits above the History toggle in the panel.
    await toggle.click();
    await expect(page.getByTestId("scm-stash")).toBeVisible();

    // The body resolves to one of: empty, error, or list. Any one of
    // those satisfies "section renders something deterministic".
    const empty = page.getByTestId("scm-stash-empty");
    const error = page.getByTestId("scm-stash-error");
    const list = page.getByTestId("scm-stash-list");
    await expect(empty.or(error).or(list).first()).toBeVisible({
      timeout: 5_000,
    });

    // Toggle closed again — body collapses.
    await toggle.click();
    await expect(page.getByTestId("scm-stash")).toHaveCount(0);
  });

  test("clicking the Stash button opens StashPushDialog; Cancel closes it", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-stash-dialog"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.getByTestId("code-mode-tab-scm").click();
    await expect(page.getByTestId("scm-panel")).toBeVisible();

    await page.getByTestId("scm-stash-push").click();
    const dialog = page.getByTestId("stash-push-dialog");
    await expect(dialog).toBeVisible();

    await expect(page.getByTestId("stash-push-message")).toBeVisible();
    await expect(page.getByTestId("stash-push-include-untracked")).toBeVisible();
    await expect(page.getByTestId("stash-push-submit")).toBeVisible();

    // Cancel — dialog closes without firing a mutation.
    await page.getByTestId("stash-push-cancel").click();
    await expect(dialog).toHaveCount(0);
  });

  test("stash-list-empty: visual baseline (collapsed-then-expanded, stub backend)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-stash-empty-vis"));
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
    await expect(page.getByTestId("scm-panel")).toBeVisible();

    await page.getByTestId("scm-stash-toggle").click();
    const body = page.getByTestId("scm-stash");
    await expect(body).toBeVisible();

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    // Visual baseline lives at:
    //   ui/e2e/__screenshots__/stash.spec.ts/stash-list-empty.png
    // The slice spec asks for the file at `__screenshots__/stash-list-empty.png`;
    // playwright's `snapshotPathTemplate` stores it inside the per-spec
    // folder, so the canonical path includes `stash.spec.ts/`.
    await expect(body).toHaveScreenshot("stash-list-empty.png", {
      maxDiffPixelRatio: 0.05,
    });
  });

  test("stash-list-populated: visual baseline", async ({ page }) => {
    // Needs a deterministic mount path that yields a populated stash
    // list. The stubbed e2e backend has no real `.git/`, and we have no
    // dev-preview route for the StashSection yet. When one lands —
    // either a backend that seeds a real repo with stash entries, or a
    // `/dev/stash-section-preview` route — flip this skip and capture
    // the baseline at:
    //   ui/e2e/__screenshots__/stash.spec.ts/stash-list-populated.png
    test.skip(
      true,
      "StashSection has no deterministic populated mount path yet — requires a seeded git repo or a dev-preview route. Visual coverage lives in the unit test for now.",
    );

    await page.goto("/dev/stash-section-preview");
    const list = page.getByTestId("scm-stash-list");
    await expect(list).toBeVisible();
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });
    await expect(list).toHaveScreenshot("stash-list-populated.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("stash-confirm-pop: visual baseline of the per-row Pop interaction", async ({
    page,
  }) => {
    // Same constraint as stash-list-populated — we need a populated
    // list to surface the per-row dropdown menu and capture its Pop
    // option visible. Skipped until a deterministic mount path lands.
    test.skip(
      true,
      "StashSection has no deterministic populated mount path yet — requires a seeded git repo or a dev-preview route. Visual coverage lives in the unit test for now.",
    );

    await page.goto("/dev/stash-section-preview");
    await page.getByTestId("scm-stash-menu-stash@{0}").click();
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible();
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });
    await expect(menu).toHaveScreenshot("stash-confirm-pop.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
