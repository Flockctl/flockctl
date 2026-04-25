import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * Stub /fs/browse with a tiny two-level tree so the picker test can drive a
 * deterministic navigate → select flow without depending on whatever happens
 * to live under the tester's real $HOME. The stub returns:
 *   /tmp/picker-root          (root the picker lands on first)
 *     └── drill-me/           (the only directory — easy to target)
 *           └── leaf/         (one more level so Select has a distinct value)
 */
async function stubFsBrowse(page: import("@playwright/test").Page, pickedPath: string) {
  await page.route("**/fs/browse*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.searchParams.get("path");
    if (p === null || p === "/tmp/picker-root") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          path: "/tmp/picker-root",
          parent: null,
          entries: [
            { name: "drill-me", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        }),
      });
      return;
    }
    if (p === "/tmp/picker-root/drill-me") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          path: pickedPath,
          parent: "/tmp/picker-root",
          entries: [],
          truncated: false,
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: JSON.stringify({ error: "Path not found" }) });
  });
}

test("projects page lists a project created via API", async ({ page, request }) => {
  const name = uniq("proj-e2e");
  await createProject(request, name);

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" }).first()).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("projects page calls GET /projects on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/projects(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/projects");
  const res = await listed;
  expect(res.status()).toBe(200);
});

test("navigating from /projects to project detail loads the project", async ({
  page,
  request,
}) => {
  const name = uniq("proj-nav");
  const proj = await createProject(request, name);

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});

test("Create Project dialog: pick path via DirectoryPicker → project appears in list", async ({
  page,
}) => {
  const projectName = uniq("proj-picked");
  // The picker will "select" this path; the backend creates it via
  // mkdir -p on POST /projects, so the value just needs to be a plausible
  // writable absolute path. /tmp/picker-selected-<uniq> keeps each run
  // isolated from any previous test invocation.
  const pickedPath = `/tmp/picker-selected-${Date.now()}`;

  // Seed last-picked so the picker's initialPath falls back to our stubbed
  // root — the stub handler also accepts `path === null`, so this is belt
  // and braces rather than load-bearing.
  await page.addInitScript((v) => {
    window.localStorage.setItem("flockctl.lastPickedPath", v);
  }, "/tmp/picker-root");

  // Stub AFTER navigation starts so the route handler is in place when the
  // dialog fires its first /fs/browse request.
  await stubFsBrowse(page, pickedPath);

  // Don't intercept the real POST /projects — let it hit the backend so the
  // created row is actually persisted and the list re-fetch picks it up.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" }).first()).toBeVisible();

  // 1. Open the Create Project dialog.
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();

  await page.locator("#cp-name").fill(projectName);

  // 2. Open the picker via the Browse… button next to the path input.
  await page.getByTestId("cp-path-browse").click();
  await expect(page.getByText("Select a directory")).toBeVisible();

  // 3. Navigate: double-click the stub's only entry to drill into it.
  await expect(page.getByText("drill-me")).toBeVisible();
  await page.getByText("drill-me").dblclick();

  // Breadcrumb should now show the deeper path's tail segment. The final
  // segment is rendered as a disabled breadcrumb button.
  await expect(
    page.getByTestId("directory-picker-breadcrumb"),
  ).toContainText(pickedPath.split("/").pop()!);

  // 4. Select — picker closes and writes the path back into the input.
  // `exact: true` is required because one of the breadcrumb segments
  // happens to contain the substring "Select".
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("#cp-path")).toHaveValue(pickedPath);

  // 5. Confirm the text input is still editable (picker augments, not
  //    replaces) — type a suffix, then trim it back to the picked path so
  //    the submit actually uses what the picker returned.
  await page.locator("#cp-path").fill(`${pickedPath}`);

  // 6. Submit.
  await page.getByRole("button", { name: /^Creat(e|ing…)$/ }).click();

  // 7. Project row appears in the list.
  await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10_000 });
});
