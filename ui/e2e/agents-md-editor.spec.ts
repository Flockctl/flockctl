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
      await page.goto(`/projects/${proj.id}/settings`);
      await expect(
        page.getByRole("heading", { name: "Project Settings" }),
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
      await page.goto(`/projects/${proj.id}/settings`);
      await expect(
        page.getByRole("heading", { name: "Project Settings" }),
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
      await page.getByRole("button", { name: /^save$/i }).click();
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
      await page.goto(`/projects/${proj.id}/settings`);
      await expect(
        page.getByRole("heading", { name: "Project Settings" }),
      ).toBeVisible({ timeout: 10_000 });
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
      await page.getByRole("button", { name: /^save$/i }).click();
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
      await page.goto(`/projects/${proj.id}/settings`);
      await expect(
        page.getByRole("heading", { name: "Project Settings" }),
      ).toBeVisible({ timeout: 10_000 });
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
      await page.goto(`/workspaces/${ws.id}/settings`);
      await expect(
        page.getByRole("heading", { name: "Workspace Settings" }),
      ).toBeVisible({ timeout: 10_000 });

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
