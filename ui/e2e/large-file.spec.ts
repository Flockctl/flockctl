import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the large-file opt-in flow in Code-mode. The slice's contract:
 *
 *   1. Opening a file larger than the daemon's 2 MiB whole-file ceiling
 *      surfaces the {@link LargeFileTooBig} empty state with a parsed
 *      size and a "Open first 64 KB read-only" button.
 *   2. Clicking the button re-fires the read with `?range=bytes=0-65535`
 *      and the editor mounts in partial mode — Monaco visible,
 *      `data-partial="true"`, and a sticky
 *      `large-file-partial-banner` above it advertising "Showing partial
 *      content (X KB of Y MB). Read-only.".
 *
 * The e2e backend's project paths live under `/tmp/<name>`; we pre-seed
 * a 3 MiB file on disk so the daemon's read-flow returns `fs_too_large`
 * verbatim. Cleanup deletes the scratch directory regardless of test
 * outcome so /tmp doesn't fill up across runs.
 *
 * Visual baselines for the empty state and the partial-open banner live
 * under `ui/e2e/__screenshots__/large-file.spec.ts/`. Regenerate with:
 *   npm run e2e:update -- large-file
 */

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function cleanupDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* swallow — best-effort cleanup */
  }
}

/**
 * Pre-seed a 3 MiB file at `<root>/big.log`. Three MiB is comfortably
 * over the 2 MiB whole-file ceiling and well under any test-runner
 * memory pressure threshold. Filling with `'a'` keeps the bytes ASCII
 * so the partial slice decodes cleanly as UTF-8 (no replacement-char
 * boundary chaos to debug if the snapshot drifts).
 */
function seedLargeFile(root: string): { path: string; bytes: number } {
  ensureDir(root);
  const bytes = 3 * 1024 * 1024;
  const buf = Buffer.alloc(bytes, "a");
  writeFileSync(join(root, "big.log"), buf);
  return { path: "big.log", bytes };
}

test.describe("CodeModeEditor — large-file opt-in", () => {
  test("fs_too_large surfaces LargeFileTooBig empty state", async ({
    page,
    request,
  }) => {
    const name = uniq("large-file");
    const root = `/tmp/${name}`;
    seedLargeFile(root);
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=code`);

      const codeRoot = page.getByTestId("code-mode-root");
      test.skip(
        !(await codeRoot.isVisible().catch(() => false)),
        "CodeMode is not mounted on the project-detail page yet.",
      );

      // Open the seeded file via the tree.
      const row = page.getByTestId("file-tree-row-big.log");
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();

      // Empty state is rendered in place of the editor.
      const tooBig = page.getByTestId("large-file-too-big");
      await expect(tooBig).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByTestId("large-file-too-big-path"),
      ).toHaveText("big.log");
      await expect(
        page.getByTestId("large-file-too-big-size"),
      ).toContainText("3 MB");

      const button = page.getByTestId("large-file-open-partial");
      await expect(button).toBeVisible();
      await expect(button).toHaveText(/Open first 64 KB read-only/);

      // Visual baseline for the empty state.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
      });
      await expect(tooBig).toHaveScreenshot("large-file-opt-in.png", {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupDir(root);
    }
  });

  test("clicking open-partial mounts editor with partial banner", async ({
    page,
    request,
  }) => {
    const name = uniq("large-file-partial");
    const root = `/tmp/${name}`;
    seedLargeFile(root);
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=code`);

      const codeRoot = page.getByTestId("code-mode-root");
      test.skip(
        !(await codeRoot.isVisible().catch(() => false)),
        "CodeMode is not mounted on the project-detail page yet.",
      );

      const row = page.getByTestId("file-tree-row-big.log");
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();

      await expect(page.getByTestId("large-file-too-big")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByTestId("large-file-open-partial").click();

      // The partial banner mounts above the editor.
      const banner = page.getByTestId("large-file-partial-banner");
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await expect(banner).toContainText("Showing partial content");
      await expect(banner).toContainText("64 KB");
      await expect(banner).toContainText("3 MB");
      await expect(banner).toContainText("Read-only");

      // The editor wrapper switches to partial mode.
      const editor = page.getByTestId("code-editor");
      await expect(editor).toHaveAttribute("data-partial", "true");

      // Visual baseline for the partial editor.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
      });
      await expect(editor).toHaveScreenshot("large-file-partial-open.png", {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupDir(root);
    }
  });
});
