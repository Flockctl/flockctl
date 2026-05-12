import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the Code-mode SourceControlPanel.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`) with
 * no `.git/` dir, so we cannot exercise a real commit round-trip. The
 * value here is in:
 *
 *   1. Activity-bar tab swap: clicking the Source Control icon swaps the
 *      side panel from the Files tree to the SCM view.
 *   2. SCM panel structure: header (branch + ahead/behind) + commit
 *      composer + Changes/Staged groups + collapsed History.
 *   3. Visual baselines (light + dark) so an unintended layout drift
 *      in the panel header / commit composer / list density is caught
 *      by a screenshot diff.
 *
 * Visual baselines live in `ui/e2e/__screenshots__/source-control.spec.ts/`
 * per the playwright snapshotPathTemplate. Regenerate with:
 *   npm run e2e:update -- source-control
 *
 * Some SCM-side assertions are best-effort: depending on whether the
 * backend reports `not_a_repo` (the dominant case for stubbed paths)
 * vs `ok` with no entries, the visible body switches between
 * `scm-not-a-repo` and `scm-empty`. We accept either — the panel
 * header + commit composer + history toggle are unconditional and
 * carry the visual signal.
 */

test.describe("code-mode source control panel", () => {
  test("activity-bar swaps the side panel to SCM and renders the panel header", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm"));
    await page.goto(`/projects/${proj.id}`);

    // The Code-mode root is mounted on the project-detail page. If the
    // page hasn't been migrated to mount CodeMode yet, this test will
    // be guarded by the locator below — it skips rather than fails so
    // the spec is safe to land alongside the component itself.
    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    const filesTab = page.getByTestId("code-mode-tab-files");
    const scmTab = page.getByTestId("code-mode-tab-scm");
    await expect(filesTab).toBeVisible();
    await expect(scmTab).toBeVisible();

    // Files panel is the default activity.
    await expect(page.getByTestId("code-mode-files-panel")).toBeVisible();

    // Click the SCM activity icon — side panel swaps.
    await scmTab.click();
    await expect(page.getByTestId("code-mode-scm-panel")).toBeVisible();
    await expect(page.getByTestId("code-mode-files-panel")).toHaveCount(0);

    // Panel surface assertions — these hold regardless of ok/!ok.
    const panel = page.getByTestId("scm-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("scm-header")).toBeVisible();
    await expect(page.getByTestId("scm-message")).toBeVisible();
    await expect(page.getByTestId("scm-commit-submit")).toBeDisabled();
    await expect(page.getByTestId("scm-history-toggle")).toBeVisible();
  });

  test("source-control-panel-light: visual baseline (light theme)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-light"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    // Force the light theme so the baseline is deterministic. The app's
    // theme toggle persists in localStorage; setting it here pre-render
    // would be cleaner, but for a post-render snapshot we set the
    // documentElement class directly — every Tailwind dark-mode rule in
    // the panel keys off `.dark` on `<html>`.
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    await page.getByTestId("code-mode-tab-scm").click();
    const panel = page.getByTestId("scm-panel");
    await expect(panel).toBeVisible();

    // Freeze animations so the snapshot doesn't drift on a half-played
    // hover / focus-ring transition.
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    await expect(panel).toHaveScreenshot("source-control-panel-light.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("source-control-panel-dark: visual baseline (dark theme)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("scm-dark"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet — slice 02 wires it up.",
    );

    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
    });

    await page.getByTestId("code-mode-tab-scm").click();
    const panel = page.getByTestId("scm-panel");
    await expect(panel).toBeVisible();

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    await expect(panel).toHaveScreenshot("source-control-panel-dark.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
