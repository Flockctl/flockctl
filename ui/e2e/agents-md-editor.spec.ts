import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createProject, createWorkspace, uniq } from "./_helpers";

// ---------------------------------------------------------------------------
// AgentsMdEditor — flat single-layer editor on project-settings and
// workspace-settings pages.
//
// Private layers were retired: each scope now owns exactly one editable
// public AGENTS.md file (see docs/AGENTS-LAYERING.md). These tests run the
// real daemon (see playwright.config.ts) with a throwaway FLOCKCTL_HOME under
// `.e2e-data`. Project and workspace paths are inside /tmp so we can read
// them directly with node:fs to assert filesystem state — fs-browse only
// lists directory contents, so we reach past the API when the test needs to
// inspect a file's bytes.
// ---------------------------------------------------------------------------

// Where on disk will the public layer end up? Mirrors
// src/services/claude/agents-io.ts.
function publicPath(root: string): string {
  return join(root, "AGENTS.md");
}

/**
 * Ensure the project/workspace root directory exists so we can pre-seed files
 * before Playwright drives the UI. The daemon's PUT path already creates the
 * parent on demand, but the pre-seed step needs to write an AGENTS.md before
 * the daemon runs — `mkdirSync(..., recursive)` is idempotent so re-running
 * tests is safe.
 */
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Best-effort cleanup — delete the scratch root after each test so /tmp doesn't
 * fill with stale project trees. Swallows errors (the path may never have
 * been created if createProject failed).
 */
function cleanupDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Locate the editor card on the settings page. We anchor on the byte counter
 * testid (scope-specific) and walk up to the enclosing card shell. The
 * counter is always rendered whenever the editor surface is visible — in the
 * empty state the "Create" button renders the counter after the user clicks
 * it, but the card itself is already visible either way.
 */
function editorCard(page: Page, scope: "project" | "workspace"): Locator {
  const layerKey = scope === "project" ? "project-public" : "workspace-public";
  // Anchor on the empty-state testid OR the byte counter — either one lives
  // inside the card, and at least one is always present.
  return page
    .locator(
      `[data-testid="agents-md-empty-${layerKey}"], [data-testid="agents-md-byte-counter-${layerKey}"]`,
    )
    .first()
    .locator("xpath=ancestor::*[contains(@class, 'rounded-xl')][1]");
}

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

test.describe("AgentsMdEditor — project scope", () => {
  test("project page renders a single public editor (no tabs)", async ({ page, request }) => {
    const name = uniq("proj-agents-md");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(
        page.getByTestId("project-config-tab"),
      ).toBeVisible({ timeout: 10_000 });

      const card = editorCard(page, "project");
      await card.scrollIntoViewIfNeeded();

      // The empty-state CTA is visible for a fresh project — no AGENTS.md on disk yet.
      await expect(
        page.getByTestId("agents-md-empty-project-public"),
      ).toBeVisible();

      // Tabs from the old multi-layer editor must be gone — the flat editor
      // replaces them with a single surface per scope.
      await expect(
        page.getByTestId("agents-md-tab-project-public"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-project-private"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-workspace-public"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-workspace-private"),
      ).toHaveCount(0);

      await expect(card).toHaveScreenshot("project-editor.png");
    } finally {
      cleanupDir(root);
    }
  });

  test("saving the public layer writes to <project>/AGENTS.md on disk", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-agents-md-save");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(
        page.getByTestId("project-config-tab"),
      ).toBeVisible({ timeout: 10_000 });

      await editorCard(page, "project").scrollIntoViewIfNeeded();

      // Materialize the editor via the empty-state CTA. Clicking "Create"
      // seeds the draft with the template "# Agent guidance\n\n" so Save is
      // immediately enabled (dirty = true).
      const emptyState = page.getByTestId("agents-md-empty-project-public");
      await expect(emptyState).toBeVisible();
      await emptyState.getByRole("button", { name: /create/i }).click();

      const saved = page.waitForResponse(
        (r) =>
          /\/projects\/\d+\/agents-md(\?|$)/.test(r.url()) &&
          r.request().method() === "PUT",
      );
      // Scope the Save lookup to the agents-md card — the project Config tab
      // ships a sibling "Save" button for the project metadata form, and a
      // page-wide /^save$/ regex matches the metadata one first. The agents-md
      // Save button advertises "Save agent guidance" via aria-label.
      await page
        .getByRole("button", { name: "Save agent guidance" })
        .click();
      const saveRes = await saved;
      expect(saveRes.status()).toBe(200);

      // Public AGENTS.md now exists with the template the UI seeded.
      expect(readFileSync(publicPath(root), "utf-8")).toBe(
        "# Agent guidance\n\n",
      );
    } finally {
      cleanupDir(root);
    }
  });

  test("effective preview refreshes on save", async ({ page, request }) => {
    const name = uniq("proj-agents-md-effective");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      await editorCard(page, "project").scrollIntoViewIfNeeded();

      await page
        .getByTestId("agents-md-empty-project-public")
        .getByRole("button", { name: /create/i })
        .click();

      const saved = page.waitForResponse(
        (r) =>
          /\/projects\/\d+\/agents-md(\?|$)/.test(r.url()) &&
          r.request().method() === "PUT",
      );
      const effectiveRefreshed = page.waitForResponse(
        (r) =>
          /\/projects\/\d+\/agents-md\/effective(\?|$)/.test(r.url()) &&
          r.request().method() === "GET",
      );
      // Scope the Save lookup to the agents-md card — the project Config tab
      // ships a sibling "Save" button for the project metadata form, and a
      // page-wide /^save$/ regex matches the metadata one first. The agents-md
      // Save button advertises "Save agent guidance" via aria-label.
      await page
        .getByRole("button", { name: "Save agent guidance" })
        .click();
      await saved;
      await effectiveRefreshed;

      // Expand the accordion and assert the freshly-saved content is visible.
      const toggle = page.getByRole("button", {
        name: /effective preview/i,
      });
      await toggle.click();
      const preview = page.getByTestId("agents-md-effective-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("# Agent guidance");
    } finally {
      cleanupDir(root);
    }
  });

  test("pre-seeded AGENTS.md is loaded into the editor (not the empty state)", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-agents-md-preload");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const rootMarker = "# Committed guidance\n\nDo not touch.\n";
    writeFileSync(publicPath(root), rootMarker, "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      await editorCard(page, "project").scrollIntoViewIfNeeded();

      // Existing content means the empty-state CTA must NOT be rendered.
      await expect(
        page.getByTestId("agents-md-empty-project-public"),
      ).toHaveCount(0);
      // The editor surface is mounted and the byte counter shows a non-zero
      // byte count matching the pre-seeded content.
      await expect(
        page.getByTestId("agents-md-byte-counter-project-public"),
      ).toBeVisible();
    } finally {
      cleanupDir(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace scope
// ---------------------------------------------------------------------------

test.describe("AgentsMdEditor — workspace scope", () => {
  test("workspace page renders a single public editor (no tabs)", async ({ page, request }) => {
    const name = uniq("ws-agents-md");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const ws = await createWorkspace(request, name, { path: root });

    try {
      await page.goto(`/workspaces/${ws.id}?tab=config`);
      await expect(page.getByTestId("workspace-config-tab")).toBeVisible({
        timeout: 15_000,
      });

      const card = editorCard(page, "workspace");
      await card.scrollIntoViewIfNeeded();

      await expect(
        page.getByTestId("agents-md-empty-workspace-public"),
      ).toBeVisible();

      // No layer tabs anywhere — neither scope shows them anymore.
      await expect(
        page.getByTestId("agents-md-tab-workspace-public"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-workspace-private"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-project-public"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("agents-md-tab-project-private"),
      ).toHaveCount(0);

      await expect(card).toHaveScreenshot("workspace-editor.png");
    } finally {
      cleanupDir(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Read path via <CodeEditor> + GET fs/file
//
// The editor surface is now backed by Monaco (`<CodeEditor>`) reading directly
// from the project's filesystem via `GET /projects/:id/fs/file?path=AGENTS.md`.
// These tests prove:
//   1. the Monaco container mounts and reflects the live AGENTS.md content,
//   2. the read-status header shows "loaded" once the fetch resolves,
//   3. the Monaco theme attribute flips when the app's theme flips, and
//   4. visual baselines exist for both themes so a Monaco upgrade or theme
//      regression breaks the suite loudly instead of silently.
// ---------------------------------------------------------------------------

test.describe("AgentsMdEditor — Monaco read path", () => {
  test("Monaco editor renders the live AGENTS.md content", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-agents-md-monaco");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const seeded = "# Hello from disk\n\nLine two.\n";
    writeFileSync(publicPath(root), seeded, "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      await editorCard(page, "project").scrollIntoViewIfNeeded();

      // Header strip: "loaded" once the /fs/file fetch resolves and the
      // path label echoes the relative path the hook was asked for.
      const status = page.getByTestId("agents-md-status-project-public");
      await expect(status).toHaveText("loaded", { timeout: 10_000 });
      await expect(
        page.getByTestId("agents-md-path-project-public"),
      ).toHaveText("AGENTS.md");

      // The Monaco surface is the inner `[data-testid="code-editor"]` div
      // emitted by `CodeEditor.lazy.tsx` once Suspense resolves.
      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });

      // Monaco renders content into `.view-line` spans inside its scrolled
      // viewport. Asserting the literal text within the editor proves the
      // fs/file hook fed Monaco the file we wrote a moment ago — not the
      // empty editor or the empty-state CTA.
      await expect(monaco).toContainText("Hello from disk", {
        timeout: 10_000,
      });
    } finally {
      cleanupDir(root);
    }
  });

  test("Monaco theme attribute flips with the app theme", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-agents-md-theme");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Theme test\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      await editorCard(page, "project").scrollIntoViewIfNeeded();

      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });

      // Lock to light first. The wrapper's `data-monaco-theme` attribute is
      // fed from `useTheme().theme` so toggling the document class is enough
      // to drive the prop through the React tree on the next render.
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
        try {
          window.localStorage.setItem("flockctl-theme", "light");
        } catch {
          /* private mode */
        }
      });
      // Force a re-render by navigating again — the theme-provider boots
      // from localStorage so a reload picks up the locked value.
      await page.reload();
      await expect(monaco).toBeVisible({ timeout: 10_000 });
      await expect(monaco).toHaveAttribute("data-monaco-theme", "vs", {
        timeout: 5_000,
      });

      // Flip to dark — the wrapper updates the attribute without remounting.
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
        try {
          window.localStorage.setItem("flockctl-theme", "dark");
        } catch {
          /* private mode */
        }
      });
      await page.reload();
      await expect(monaco).toBeVisible({ timeout: 10_000 });
      await expect(monaco).toHaveAttribute("data-monaco-theme", "vs-dark", {
        timeout: 5_000,
      });
    } finally {
      cleanupDir(root);
    }
  });

  test("agents-md-editor visual baseline — light", async ({ page, request }) => {
    const name = uniq("proj-agents-md-snap-light");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Light snapshot\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
        try {
          window.localStorage.setItem("flockctl-theme", "light");
        } catch {
          /* private mode */
        }
      });
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(
        page.getByTestId("project-config-tab"),
      ).toBeVisible({ timeout: 10_000 });
      const card = editorCard(page, "project");
      await card.scrollIntoViewIfNeeded();
      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });

      // Freeze caret blink + transitions so the snapshot is deterministic.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
      });

      await expect(card).toHaveScreenshot("agents-md-editor-light.png", {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupDir(root);
    }
  });

  test("agents-md-editor visual baseline — dark", async ({ page, request }) => {
    const name = uniq("proj-agents-md-snap-dark");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Dark snapshot\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
        try {
          window.localStorage.setItem("flockctl-theme", "dark");
        } catch {
          /* private mode */
        }
      });
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(
        page.getByTestId("project-config-tab"),
      ).toBeVisible({ timeout: 10_000 });
      const card = editorCard(page, "project");
      await card.scrollIntoViewIfNeeded();
      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });

      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
      });

      await expect(card).toHaveScreenshot("agents-md-editor-dark.png", {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupDir(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Save flow — Cmd+S, dirty state, sha-conflict banner.
//
// The component holds the loaded file's sha and re-checks it before every
// PUT. When two tabs (or two browsers) edit the same AGENTS.md, whichever
// one saves second sees a sha mismatch and surfaces the conflict banner
// instead of overwriting. This block exercises:
//   - the dirty badge appearing on first edit (visual baseline),
//   - the keyboard binding (Cmd+S / Ctrl+S) triggering a save,
//   - the two-tab race producing the conflict banner in the losing tab
//     (visual baseline of the banner).
// ---------------------------------------------------------------------------

test.describe("AgentsMdEditor — save flow", () => {
  test("editing the buffer surfaces the Unsaved badge", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-agents-md-dirty");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Initial\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      const card = editorCard(page, "project");
      await card.scrollIntoViewIfNeeded();

      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });
      await expect(monaco).toContainText("Initial", { timeout: 10_000 });

      // Type into Monaco — dirty badge should mount.
      await monaco.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" — local edit");

      await expect(card.getByText("Unsaved")).toBeVisible({ timeout: 5_000 });

      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
      });
      await expect(card).toHaveScreenshot("agents-md-editor-dirty-state.png", {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupDir(root);
    }
  });

  test("Cmd+S triggers a PUT to /agents-md", async ({ page, request, browserName }) => {
    const name = uniq("proj-agents-md-cmd-s");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Initial\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    try {
      await page.goto(`/projects/${proj.id}?tab=config`);
      await expect(page.getByTestId("project-config-tab")).toBeVisible({
        timeout: 15_000,
      });
      const card = editorCard(page, "project");
      await card.scrollIntoViewIfNeeded();
      const monaco = page.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 10_000 });
      await expect(monaco).toContainText("Initial", { timeout: 10_000 });

      // Drive a change so save is enabled.
      await monaco.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" — kb edit");
      await expect(card.getByText("Unsaved")).toBeVisible();

      const saved = page.waitForResponse(
        (r) =>
          /\/projects\/\d+\/agents-md(\?|$)/.test(r.url()) &&
          r.request().method() === "PUT",
      );

      // Ctrl+S on linux/win, Meta+S on mac. Playwright canonicalises
      // `ControlOrMeta` for us — covers webkit on macOS too.
      const modifier =
        browserName === "webkit" || process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+s`);

      const res = await saved;
      expect(res.status()).toBe(200);

      // Disk reflects the keyboard-driven save.
      const onDisk = readFileSync(publicPath(root), "utf-8");
      expect(onDisk).toContain("kb edit");
    } finally {
      cleanupDir(root);
    }
  });

  test("two-tab race surfaces reload banner in losing tab", async ({
    browser,
    request,
  }) => {
    const name = uniq("proj-agents-md-race");
    const root = `/tmp/${name}`;
    ensureDir(root);
    writeFileSync(publicPath(root), "# Initial\n", "utf-8");
    const proj = await createProject(request, name, { path: root });

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      // Both tabs load the same project's settings page. They get the same
      // initial content/sha from /fs/file?path=AGENTS.md.
      for (const p of [pageA, pageB]) {
        await p.goto(`/projects/${proj.id}?tab=config`);
        await expect(p.getByTestId("project-config-tab")).toBeVisible({
          timeout: 15_000,
        });
        const card = editorCard(p, "project");
        await card.scrollIntoViewIfNeeded();
        const monaco = p.getByTestId("code-editor");
        await expect(monaco).toBeVisible({ timeout: 10_000 });
        await expect(monaco).toContainText("Initial", { timeout: 10_000 });
      }

      // Each tab makes a unique edit.
      await pageA.getByTestId("code-editor").click();
      await pageA.keyboard.press("End");
      await pageA.keyboard.type(" — A wins");

      await pageB.getByTestId("code-editor").click();
      await pageB.keyboard.press("End");
      await pageB.keyboard.type(" — B loses");

      // Tab A saves first → succeeds, advances on-disk sha.
      const aSaved = pageA.waitForResponse(
        (r) =>
          /\/projects\/\d+\/agents-md(\?|$)/.test(r.url()) &&
          r.request().method() === "PUT",
      );
      await pageA.getByRole("button", { name: "Save agent guidance" }).click();
      const aRes = await aSaved;
      expect(aRes.status()).toBe(200);

      // Tab B saves second → conflict probe sees the new sha, banner mounts,
      // PUT is NOT issued. Wait for the conflict probe GET to land before
      // asserting on the banner so we know B observed the sha drift.
      const bProbe = pageB.waitForResponse(
        (r) =>
          /\/projects\/\d+\/fs\/file\?.*path=AGENTS\.md/.test(r.url()) &&
          r.request().method() === "GET",
      );
      await pageB.getByRole("button", { name: "Save agent guidance" }).click();
      await bProbe;

      const banner = pageB.getByTestId("agents-md-conflict-banner");
      await expect(banner).toBeVisible({ timeout: 5_000 });
      await expect(
        pageB.getByTestId("agents-md-conflict-reload"),
      ).toBeVisible();
      await expect(
        pageB.getByTestId("agents-md-conflict-keep"),
      ).toBeVisible();

      const card = editorCard(pageB, "project");
      await pageB.addStyleTag({
        content:
          "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
      });
      await expect(card).toHaveScreenshot(
        "agents-md-editor-conflict-banner.png",
        { maxDiffPixelRatio: 0.02 },
      );

      // Disk still holds A's edit — B did not overwrite.
      expect(readFileSync(publicPath(root), "utf-8")).toContain("A wins");
      expect(readFileSync(publicPath(root), "utf-8")).not.toContain("B loses");
    } finally {
      await ctxA.close();
      await ctxB.close();
      cleanupDir(root);
    }
  });
});
