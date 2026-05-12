import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the `git-status-changed` UI handler — the Code-mode tab is
 * meant to react live to `.git` mutations:
 *
 *   1. **Tree status badges refetch.** A `git-status-changed` frame
 *      invalidates the `["git-status-tree", projectId]` query so the
 *      tree's M/A/D/?? badges pick up the new state.
 *   2. **Branches list refetches.** The same frame invalidates the
 *      project-scoped git-branches key so the BranchPicker reflects
 *      a checkout / branch advance.
 *
 * The e2e backend's project paths are stubs (`/tmp/<name>`) so we cannot
 * trigger a real chokidar `.git` event by writing files. Instead we drive
 * the pure handler directly via `page.evaluate` — same pattern used by
 * `fs-changed.spec.ts`. The slow path (real WS frame round-trip) is
 * exercised by the server-side unit test
 * (`src/__tests__/services/git-watcher.test.ts`) and the UI-side handler
 * test (`ui/src/__tests__/handlers/git-status-changed.test.tsx`).
 */
test.describe("git-status-changed UI handler", () => {
  test("applyGitStatusChanged invalidates the porcelain + branches keys", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-evt"));
    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    // Drive the handler against a synthetic QueryClient so the
    // assertion is independent of whether the e2e backend wires the
    // `/ws/ui/fs` route or seeds a real git repo.
    const calls = await page.evaluate(async () => {
      const mod = await import("/src/lib/handlers/git-status-changed.ts");
      const { applyGitStatusChanged } = mod;
      const log: unknown[][] = [];
      const qc = {
        invalidateQueries: (filter: unknown) => {
          log.push([filter]);
        },
      } as unknown as Parameters<typeof applyGitStatusChanged>[0];
      applyGitStatusChanged(qc, {
        kind: "git-status-changed",
        projectId: "proj-e2e",
        ts: Date.now(),
      });
      return log;
    });

    const queryKeys = calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(queryKeys).toContainEqual(["git-status-tree", "proj-e2e"]);
    expect(queryKeys).toContainEqual([
      "projects",
      "proj-e2e",
      "git-branches",
    ]);
  });

  test("useWsConnected boolean tracks the singleton's connection bit", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("git-conn"));
    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    // Snapshot the connection state via the singleton's test seam.
    // `useWsConnected` (the React hook) is exercised by the unit
    // tests; here we just prove the singleton exposes the bit and
    // that the test seam can flip it (the polling-vs-live decision
    // in `useGitStatusForTree` reads from the same source).
    const snapshot = await page.evaluate(async () => {
      const mod = await import("/src/lib/global-ws.ts");
      const before = mod.globalWs.isConnected();
      mod.globalWs.__setConnectedForTests(true);
      const afterTrue = mod.globalWs.isConnected();
      mod.globalWs.__setConnectedForTests(false);
      const afterFalse = mod.globalWs.isConnected();
      return { before, afterTrue, afterFalse };
    });

    expect(snapshot.afterTrue).toBe(true);
    expect(snapshot.afterFalse).toBe(false);
  });
});
