import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { createProject, uniq } from "./_helpers";

/**
 * PlanFileEditor — Monaco-backed editor for milestone.md / slice.md / task.md.
 *
 * The editor is mounted inside the dialog opened via the milestone /
 * slice / task right-rail "Edit files" button on the project board view.
 * These tests exercise the post-Monaco swap (slice 02 of M00):
 *
 *   1. Monaco mounts with the markdown language id and renders the
 *      milestone.md content created by `POST /projects/:id/milestones`.
 *   2. Cmd/Ctrl+S triggers a `PUT /projects/:id/plan-file` while the
 *      editor has focus.
 *
 * The plan-file API is still the legacy plan-store endpoint — the
 * AGENTS.md sha-conflict banner contract does not apply here. See the
 * TODO M01 comment on PlanFileEditor for the unification plan.
 */

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function cleanupDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test.describe("PlanFileEditor — Monaco swap", () => {
  test("opens milestone.md in Monaco with markdown language", async ({
    page,
    request,
  }) => {
    const name = uniq("proj-plan-monaco");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const proj = await createProject(request, name, { path: root });

    // Seed a milestone — its `milestone.md` is what the editor will load.
    const mRes = await request.post(`/projects/${proj.id}/milestones`, {
      data: {
        title: "Foo",
        description: "Plan-file editor monaco fixture.",
        order: 1,
      },
    });
    expect(mRes.status()).toBe(201);
    const milestone = (await mRes.json()) as { slug?: string; id?: string };
    const milestoneSlug = milestone.slug ?? milestone.id;
    expect(milestoneSlug).toBeTruthy();

    try {
      // Deep-link the board view with the milestone preselected so the
      // right-rail MilestoneDetailPanel renders without a click.
      await page.goto(
        `/projects/${proj.id}?view=board&milestone=${milestoneSlug}`,
      );
      await expect(
        page.getByTestId("project-detail-board-view"),
      ).toBeVisible({ timeout: 15_000 });

      // Open the plan-file dialog from the milestone detail panel.
      const editFiles = page.getByTestId("milestone-detail-panel-edit-files");
      await expect(editFiles).toBeVisible({ timeout: 10_000 });
      await editFiles.click();

      // Editor surface mounts; Monaco wrapper exposes `data-testid="code-editor"`.
      const surface = page.getByTestId("plan-file-editor-surface");
      await expect(surface).toBeVisible({ timeout: 10_000 });
      const monaco = surface.getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 15_000 });

      // CodeMirror is gone — no leftover `.cm-editor` containers from the
      // pre-swap implementation.
      await expect(page.locator(".cm-editor")).toHaveCount(0);
    } finally {
      cleanupDir(root);
    }
  });

  test("Cmd+S inside the editor PUTs to /plan-file", async ({
    page,
    request,
    browserName,
  }) => {
    const name = uniq("proj-plan-cmd-s");
    const root = `/tmp/${name}`;
    ensureDir(root);
    const proj = await createProject(request, name, { path: root });

    const mRes = await request.post(`/projects/${proj.id}/milestones`, {
      data: {
        title: "Bar",
        description: "Plan-file editor save fixture.",
        order: 1,
      },
    });
    expect(mRes.status()).toBe(201);
    const milestone = (await mRes.json()) as { slug?: string; id?: string };
    const milestoneSlug = milestone.slug ?? milestone.id;

    try {
      await page.goto(
        `/projects/${proj.id}?view=board&milestone=${milestoneSlug}`,
      );
      await expect(
        page.getByTestId("project-detail-board-view"),
      ).toBeVisible({ timeout: 15_000 });

      await page.getByTestId("milestone-detail-panel-edit-files").click();

      const monaco = page
        .getByTestId("plan-file-editor-surface")
        .getByTestId("code-editor");
      await expect(monaco).toBeVisible({ timeout: 15_000 });

      // Wait for Monaco to actually load content from the GET /plan-file
      // round-trip — until then the buffer is empty and the dirty check
      // would never flip even if we started typing.
      await expect(monaco).toContainText("Bar", { timeout: 10_000 });

      await monaco.click();
      await page.keyboard.press("End");
      await page.keyboard.type("\n\n# new section");

      await expect(
        page.getByTestId("plan-file-editor-dirty"),
      ).toBeVisible({ timeout: 5_000 });

      const saved = page.waitForResponse(
        (r) =>
          /\/projects\/\d+\/plan-file(\?|$)/.test(r.url()) &&
          r.request().method() === "PUT",
      );

      const modifier =
        browserName === "webkit" || process.platform === "darwin"
          ? "Meta"
          : "Control";
      await page.keyboard.press(`${modifier}+s`);

      const res = await saved;
      expect(res.status()).toBe(200);

      // Saved badge surfaces post-success.
      await expect(
        page.getByTestId("plan-file-editor-saved"),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      cleanupDir(root);
    }
  });
});
