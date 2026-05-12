import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the Code-mode Quick-Open (Cmd+P) modal.
 *
 * The seeded e2e backend's project paths are stubs (`/tmp/<name>`)
 * with no real files, so we drive the QuickOpen index store directly
 * via `window.__quickOpenIndexStore` (same harness pattern the editor
 * tabs spec uses for `__editorTabsStore`). The store is the source of
 * truth — the modal renders whatever the store contains regardless of
 * whether the BFS walker actually produced it.
 *
 * Visual baseline: `quick-open-modal.png` — modal opened with a
 * pre-seeded index, three rows visible.
 *
 * Regenerate with:
 *   npm run e2e:update -- quick-open
 */

test.describe("code-mode quick-open", () => {
  test("Cmd+P opens the modal with the pre-fetched index", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("quick-open"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const exposed = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Boolean((window as any).__quickOpenIndexStore);
    });
    test.skip(
      !exposed,
      "quickOpenIndexStore is not exposed on window — the harness has not wired it.",
    );

    // Pre-seed the index; the modal pre-fetches on Code-mode mount but
    // the seeded backend has no real files to walk so we inject paths.
    await page.evaluate((projectId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__quickOpenIndexStore;
      store.setState({
        projectId,
        paths: [
          "src/server.ts",
          "src/routes/projects.ts",
          "src/routes/workspaces.ts",
          "README.md",
          "package.json",
        ],
        fetchedAt: Date.now(),
        isLoading: false,
        error: null,
      });
    }, proj.id);

    // Ensure focus is inside the Code-mode container so the keydown
    // listener on the wrapper picks up Cmd+P. Clicking the activity
    // bar focuses the container without changing the active activity.
    await root.click();

    // Cmd+P on Mac, Ctrl+P on Linux/Windows — Playwright's
    // `Meta+KeyP` works cross-platform when targeted at the test
    // browser regardless of host OS.
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+KeyP" : "Control+KeyP");

    const dialog = page.getByTestId("quick-open-dialog");
    await expect(dialog).toBeVisible();

    // The first row is alpha-sorted, case-insensitive.
    const rows = dialog.getByTestId("quick-open-row");
    await expect(rows.first()).toHaveAttribute("data-path", "package.json");

    // Esc closes.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("typing fuzzy-filters the list and Enter opens an editor tab", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("quick-open-type"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    await page.evaluate((projectId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__quickOpenIndexStore;
      store.setState({
        projectId,
        paths: [
          "src/components/Header.tsx",
          "src/components/Footer.tsx",
          "src/server/db.ts",
          "README.md",
        ],
        fetchedAt: Date.now(),
        isLoading: false,
        error: null,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__editorTabsStore.getState().__resetForTests();
    }, proj.id);

    await root.click();
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+KeyP" : "Control+KeyP");

    const dialog = page.getByTestId("quick-open-dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.type("header");

    const rows = dialog.getByTestId("quick-open-row");
    await expect(rows.first()).toHaveAttribute(
      "data-path",
      "src/components/Header.tsx",
    );

    // Enter opens the active row.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();

    const tabsAfter = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__editorTabsStore
        .getState()
        .tabs.map((t: { path: string }) => t.path);
    });
    expect(tabsAfter).toEqual(["src/components/Header.tsx"]);
  });

  test("ArrowDown moves selection then Enter opens that row", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("quick-open-arrow"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    await page.evaluate((projectId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__quickOpenIndexStore;
      store.setState({
        projectId,
        paths: ["alpha.ts", "beta.ts", "gamma.ts"],
        fetchedAt: Date.now(),
        isLoading: false,
        error: null,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__editorTabsStore.getState().__resetForTests();
    }, proj.id);

    await root.click();
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+KeyP" : "Control+KeyP");

    const dialog = page.getByTestId("quick-open-dialog");
    await expect(dialog).toBeVisible();

    // Move once → beta.ts is now active.
    await page.keyboard.press("ArrowDown");
    const rows = dialog.getByTestId("quick-open-row");
    await expect(rows.nth(1)).toHaveAttribute("data-active", "true");

    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();

    const paths = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__editorTabsStore
        .getState()
        .tabs.map((t: { path: string }) => t.path);
    });
    expect(paths).toEqual(["beta.ts"]);
  });

  test("quick-open-modal: visual baseline", async ({ page, request }) => {
    const proj = await createProject(request, uniq("quick-open-vis"));
    await page.goto(`/projects/${proj.id}`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    // Force light theme + freeze animations so the screenshot is stable.
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    await page.evaluate((projectId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__quickOpenIndexStore;
      store.setState({
        projectId,
        paths: [
          "src/components/Header.tsx",
          "src/components/Footer.tsx",
          "src/server/db.ts",
          "README.md",
          "package.json",
        ],
        fetchedAt: Date.now(),
        isLoading: false,
        error: null,
      });
    }, proj.id);

    await root.click();
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+KeyP" : "Control+KeyP");

    const dialog = page.getByTestId("quick-open-dialog");
    await expect(dialog).toBeVisible();

    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
    });

    await expect(dialog).toHaveScreenshot("quick-open-modal.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
