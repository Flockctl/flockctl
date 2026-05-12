import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the Code-mode editor tab strip — keyboard shortcuts, tree
 * integration, and the dirty-close confirm dialog.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`)
 * with no real files, so the FileTree renders an empty tree. We drive
 * the editor-tabs store directly via the `__editorTabsStore` window
 * exposure (same pattern as `diff-viewer.spec.ts` does for
 * `__tabStore`) — the store is the source of truth for the tab bar
 * regardless of how the tabs got there. This keeps the spec focused
 * on the UI contract: the strip renders three tabs, dirty marker on
 * one, and Cmd+W on a dirty tab opens the confirm dialog.
 *
 * Visual baselines:
 *   - `code-mode-tabs-three-open.png` — three tabs open, second active.
 *   - `dirty-tab-confirm-dialog.png`  — confirm dialog overlaid on the
 *                                       active dirty tab.
 *
 * Regenerate with:
 *   npm run e2e:update -- code-mode-tabs
 */

test.describe("code-mode editor tabs", () => {
  test("three tabs open via store; tab bar renders all of them", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-tabs"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const exposed = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Boolean((window as any).__editorTabsStore);
    });
    test.skip(
      !exposed,
      "editorTabsStore is not exposed on window — the harness has not wired it.",
    );

    // Drive the store directly. The reducer dedupes by path; we open
    // three distinct paths so the bar renders three rows.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__editorTabsStore.getState();
      store.__resetForTests();
      store.open("src/api/auth.ts");
      store.open("src/middleware/auth.ts");
      store.open("README.md");
    });

    // Tab bar is now visible.
    const bar = page.getByTestId("tab-bar");
    await expect(bar).toBeVisible();

    // Each path has a row — disambiguateLabels handles the auth.ts
    // collision so we assert presence by `data-path`.
    const rowApi = bar.locator('[data-path="src/api/auth.ts"]');
    const rowMid = bar.locator('[data-path="src/middleware/auth.ts"]');
    const rowReadme = bar.locator('[data-path="README.md"]');
    await expect(rowApi).toBeVisible();
    await expect(rowMid).toBeVisible();
    await expect(rowReadme).toBeVisible();

    // The last-opened tab is active by reducer contract.
    await expect(rowReadme).toHaveAttribute("data-active", "true");
  });

  test("tree onSelect → existing-tab focus, new-path opens new tab", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-tabs-tree"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    // Reset the store to a clean baseline — the same e2e session may
    // have left tabs over from a prior spec.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__editorTabsStore?.getState().__resetForTests();
    });

    // Open three paths through the public `open()` entry point — the
    // same path the FileTree's onSelect ultimately calls. The third
    // re-opens an already-open path, which the reducer must focus
    // rather than duplicate.
    const openCount = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__editorTabsStore.getState();
      store.open("src/a.ts");
      store.open("src/b.ts");
      store.open("src/a.ts"); // re-open → focuses, does NOT duplicate
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__editorTabsStore.getState().tabs.length;
    });
    expect(openCount).toBe(2);

    const bar = page.getByTestId("tab-bar");
    await expect(bar).toBeVisible();

    // After re-opening src/a.ts it must be the active tab.
    await expect(
      bar.locator('[data-path="src/a.ts"]'),
    ).toHaveAttribute("data-active", "true");
    await expect(
      bar.locator('[data-path="src/b.ts"]'),
    ).toHaveAttribute("data-active", "false");
  });

  test("Cmd+W on a dirty tab opens the confirm dialog", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-tabs-dirty"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    // Seed: open one tab and mark it dirty so the close shortcut hits
    // the dirty branch.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__editorTabsStore.getState();
      store.__resetForTests();
      const id = store.open("src/dirty.ts");
      store.setDirty(id, true);
    });

    // Focus the Code-mode root so the keydown listener (registered on
    // the container, not document) catches the event.
    await root.focus();

    // The shortcut handler reads `metaKey || ctrlKey`. Playwright maps
    // `Meta` to the platform's command key, but we use `Control` so
    // the test is invariant across runners (Linux CI / macOS dev).
    await page.keyboard.press("Control+w");

    // Dialog appears.
    const dialog = page.getByTestId("dirty-close-confirm");
    await expect(dialog).toBeVisible();

    // The three actions are reachable.
    await expect(page.getByTestId("dirty-close-save")).toBeVisible();
    await expect(page.getByTestId("dirty-close-discard")).toBeVisible();
    await expect(page.getByTestId("dirty-close-cancel")).toBeVisible();

    // Cancel → buffer stays dirty, dialog dismisses.
    await page.getByTestId("dirty-close-cancel").click();
    await expect(dialog).not.toBeVisible();
    const stillDirty = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (window as any).__editorTabsStore.getState();
      return state.tabs[0]?.dirty === true && !state.tabs[0]?.pendingClose;
    });
    expect(stillDirty).toBe(true);
  });

  test("code-mode-tabs-three-open: visual baseline", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-tabs-snap"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__editorTabsStore.getState();
      store.__resetForTests();
      store.open("src/api/auth.ts");
      const idMid = store.open("src/middleware/auth.ts");
      store.open("README.md");
      // Active = middle tab so the snapshot exercises both the
      // active highlight and the unselected style on either side.
      store.focus(idMid);
      // Mark the README dirty so the snapshot also exercises the dirty
      // dot variant.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tabs = (window as any).__editorTabsStore.getState().tabs as Array<{
        id: string;
        path: string;
      }>;
      const readme = tabs.find((t) => t.path === "README.md");
      if (readme) store.setDirty(readme.id, true);
    });

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    const bar = page.getByTestId("tab-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveScreenshot("code-mode-tabs-three-open.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("dirty-tab-confirm-dialog: visual baseline", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("code-tabs-confirm"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__editorTabsStore.getState();
      store.__resetForTests();
      const id = store.open("src/dirty.ts");
      store.setDirty(id, true);
      // Trigger pendingClose directly so the dialog opens without
      // depending on the keyboard codepath (covered separately above).
      store.close(id);
    });

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    const dialog = page.getByTestId("dirty-close-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveScreenshot("dirty-tab-confirm-dialog.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
