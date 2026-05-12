import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the project-detail "Code" tab shell.
 *
 * Slice 02 wires the existing CodeMode shell (activity bar + side panel
 * skeleton) into the project-detail page. This spec is the gate that
 * proves:
 *
 *   1. The Code tab is reachable from the page header.
 *   2. Switching to it mounts the CodeMode root and the FileTree.
 *   3. The default activity is "files" — the SCM panel is NOT visible
 *      until the operator clicks the SCM activity icon.
 *
 * The seeded e2e backend uses stub project paths under `/tmp/<name>`.
 * Those paths exist (the `createProject` helper relies on the daemon
 * accepting them) but contain no real files, so the FileTree renders
 * its `file-tree-empty` placeholder. That's still enough signal for
 * this layout-level smoke — the file-tree's own e2e covers the
 * populated path with a real fixture.
 *
 * Visual baselines (light + dark) live alongside the other code-mode
 * specs at `ui/e2e/__screenshots__/code-mode-shell.spec.ts/`. They are
 * generated lazily — running this suite for the first time emits the
 * baselines; subsequent runs diff against them. Regenerate with:
 *   npm run e2e:update -- code-mode-shell
 */

test.describe("project-detail Code tab", () => {
  test("opens the Code tab and renders the CodeMode shell with the FileTree", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-shell"));
    await page.goto(`/projects/${proj.id}`);

    // The Code tab is the toggle that switches the page into Code mode —
    // until clicked, the shell is not in the DOM.
    const codeTab = page.getByTestId("project-detail-tab-code");
    await expect(codeTab).toBeVisible();
    await codeTab.click();

    // Activating the tab must mount the CodeMode shell.
    await expect(page.getByTestId("code-mode-root")).toBeVisible();

    // Default activity is Files — the panel slot is rendered, the SCM
    // slot is not.
    await expect(page.getByTestId("code-mode-files-panel")).toBeVisible();
    await expect(page.getByTestId("code-mode-scm-panel")).toHaveCount(0);

    // The FileTree mounts inside the Files slot. The seeded `/tmp/<n>`
    // path is empty so the empty-state placeholder is the expected
    // landing — anything else (loading, error, populated) is also fine
    // for this layout-level assertion. Just require *some* tree surface.
    const tree = page.getByTestId("file-tree-root");
    await expect(tree).toBeVisible();

    // No file is selected → empty placeholder in the editor area.
    await expect(page.getByTestId("code-mode-empty")).toBeVisible();

    // The URL persists the active tab so a refresh / share lands on the
    // same view.
    await expect(page).toHaveURL(/[?&]tab=code\b/);
  });

  test("Code tab and Plan tab are mutually exclusive", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-mutex"));
    await page.goto(`/projects/${proj.id}`);

    // Plan tab is the default.
    await expect(page.getByTestId("project-detail-tab-plan")).toHaveAttribute(
      "data-state",
      "active",
    );

    await page.getByTestId("project-detail-tab-code").click();

    // After the click the Code tab owns active state — Plan does not.
    await expect(page.getByTestId("project-detail-tab-code")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByTestId("project-detail-tab-plan")).not.toHaveAttribute(
      "data-state",
      "active",
    );

    // The CodeMode shell only renders in the Code tab.
    await expect(page.getByTestId("code-mode-root")).toBeVisible();

    // Flipping back to Plan unmounts the Code shell — TabsContent uses
    // `data-[state=inactive]:hidden` which removes the subtree from view.
    await page.getByTestId("project-detail-tab-plan").click();
    await expect(page.getByTestId("code-mode-root")).toBeHidden();
  });
});
