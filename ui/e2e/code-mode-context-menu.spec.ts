import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the file-tree right-click context menu.
 *
 * What we exercise:
 *   1. Right-click on a file row opens the menu with file-only items
 *      (no New File / New Folder).
 *   2. Right-click on a folder row opens the menu with the full set —
 *      including New File / New Folder.
 *   3. "Delete" opens the confirm dialog (we don't actually run the
 *      mutation in e2e to keep this spec idempotent on the seeded
 *      backend).
 *   4. The menu is dismissable via Escape — Radix's default keyboard
 *      contract.
 *
 * The e2e backend's project paths are stubs (`/tmp/<name>`) with no
 * real files. We intercept `GET /projects/:id/fs/list` to feed a
 * deterministic shape so the rows we want to right-click are present.
 * The fs-mutation endpoint (`POST /projects/:id/fs/op`) is also
 * stubbed to a successful no-op — the spec doesn't need a real
 * filesystem mutation to assert the UI contract.
 */

test.describe("code-mode file-tree context menu", () => {
  test("right-click on a file row opens the menu without folder-only items", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("ctx-file"));

    await page.route(`**/projects/${proj.id}/fs/list*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          path: ".",
          entries: [
            {
              name: "README.md",
              type: "file",
              ignored: false,
              size: 100,
              mtime: Date.now(),
            },
          ],
          truncated: false,
        }),
      });
    });

    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const row = page.getByTestId("file-tree-row-README.md");
    await expect(row).toBeVisible();

    await row.click({ button: "right" });

    // Common items present on both kinds.
    await expect(page.getByTestId("tree-context-menu-rename")).toBeVisible();
    await expect(page.getByTestId("tree-context-menu-delete")).toBeVisible();
    await expect(
      page.getByTestId("tree-context-menu-copy-path"),
    ).toBeVisible();
    await expect(
      page.getByTestId("tree-context-menu-copy-relative-path"),
    ).toBeVisible();

    // Folder-only items absent on a file row.
    await expect(
      page.getByTestId("tree-context-menu-new-file"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("tree-context-menu-new-folder"),
    ).toHaveCount(0);

    // Escape dismisses.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tree-context-menu-rename")).toHaveCount(0);
  });

  test("right-click on a folder row exposes New File / New Folder", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("ctx-folder"));

    await page.route(`**/projects/${proj.id}/fs/list*`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.searchParams.get("path") ?? "";
      if (path === "") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            path: ".",
            entries: [
              {
                name: "src",
                type: "dir",
                ignored: false,
                hasChildren: true,
                mtime: Date.now(),
              },
            ],
            truncated: false,
          }),
        });
        return;
      }
      // Any nested listing the lazy loader requests — empty.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          path,
          entries: [],
          truncated: false,
        }),
      });
    });

    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const row = page.getByTestId("file-tree-row-src");
    await expect(row).toBeVisible();

    await row.click({ button: "right" });

    await expect(
      page.getByTestId("tree-context-menu-new-file"),
    ).toBeVisible();
    await expect(
      page.getByTestId("tree-context-menu-new-folder"),
    ).toBeVisible();
    await expect(page.getByTestId("tree-context-menu-rename")).toBeVisible();
    await expect(page.getByTestId("tree-context-menu-delete")).toBeVisible();
  });

  test("Delete opens a confirm dialog naming the row's path", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("ctx-delete"));

    await page.route(`**/projects/${proj.id}/fs/list*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          path: ".",
          entries: [
            {
              name: "doomed.txt",
              type: "file",
              ignored: false,
              size: 1,
              mtime: Date.now(),
            },
          ],
          truncated: false,
        }),
      });
    });

    // Stub the mutation so a misclick on Confirm doesn't try to nuke
    // anything on the seeded backend.
    await page.route(`**/projects/${proj.id}/fs/op`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const row = page.getByTestId("file-tree-row-doomed.txt");
    await expect(row).toBeVisible();

    await row.click({ button: "right" });
    await page.getByTestId("tree-context-menu-delete").click();

    // Confirm dialog body mentions the path.
    await expect(page.getByText(/doomed\.txt/)).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toBeVisible();

    // Cancel — leaves the file alone, dismisses dialog.
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByText(/cannot be undone/i)).toHaveCount(0);
  });
});
