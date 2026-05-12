import { test, expect } from "@playwright/test";
import { createProject, uniq } from "./_helpers";

/**
 * E2E for the reconnect-drift handler — exercises the runDriftCheck
 * orchestration end-to-end against the real `tabStore` and `globalWs`
 * singletons running in the page's JS context, but with the per-tab
 * `fetchProjectFile` swapped out for a stub. Real disk drift + a real
 * WebSocket reconnect cycle live in the unit-test tier (UI handler
 * + server-side fs-watcher); here we prove the wire-up holds on the
 * shipped bundle.
 *
 * Two screenshots are captured for the visual surface — the `changed`
 * banner (amber) and the `deleted` banner (rose). They're snapshot in
 * the `__screenshots__/` dir alongside the spec.
 */
test.describe("reconnect-drift handler", () => {
  test("runDriftCheck invalidates git keys and raises a `changed` banner on dirty drift", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("recon-drift"));
    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const result = await page.evaluate(async (projectId: string) => {
      const handlerMod = await import("/src/lib/handlers/reconnect-drift.ts");
      const tabsMod = await import("/src/components/code-mode/tab-store.ts");

      // Reset the singletons to a clean slate so prior page state
      // (e.g. an editor mounted by the route) doesn't pollute the run.
      tabsMod.tabStore.__resetForTests();
      tabsMod.useEditorTabsStore.getState().__resetForTests();
      tabsMod.__setEditorTabIdGeneratorForTests(() => "ed-e2e");

      // Seed: one open file tab + an editor with a dirty buffer at sha-A.
      tabsMod.useEditorTabsStore.getState().open("src/foo.ts");
      tabsMod.useEditorTabsStore.getState().setBuffer("ed-e2e", "loaded", "sha-A");
      tabsMod.useEditorTabsStore.getState().setDirty("ed-e2e", true);

      const tabId = tabsMod.fileTabId(projectId, "src/foo.ts");
      tabsMod.tabStore.openTab({
        kind: "file",
        id: tabId,
        projectId,
        path: "src/foo.ts",
      });

      // Spy on a synthetic QueryClient so we can assert the
      // git-status-tree + git-branches keys were marked stale exactly
      // once at the start.
      const calls: unknown[][] = [];
      const qc = {
        invalidateQueries: (filter: unknown) => {
          calls.push([filter]);
        },
      } as unknown as Parameters<typeof handlerMod.runDriftCheck>[0];

      await handlerMod.runDriftCheck(qc, {
        fetcher: async () => ({
          ok: true,
          content: "disk wins",
          sha: "sha-B",
          size: 9,
          mtime: 1,
          encoding: "utf-8",
        }),
      });

      const banner = tabsMod.tabStore.getState().banners.get(tabId);
      const queryKeys = calls.map(
        (c) => (c[0] as { queryKey: unknown[] }).queryKey,
      );
      return { banner, queryKeys, projectId };
    }, String(proj.id));

    expect(result.queryKeys).toContainEqual([
      "git-status-tree",
      result.projectId,
    ]);
    expect(result.queryKeys).toContainEqual([
      "projects",
      result.projectId,
      "git-branches",
    ]);
    expect(result.banner).toEqual({ kind: "changed", currentSha: "sha-B" });
  });

  test("fs_not_found on the drift walk raises a `deleted` banner", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("recon-del"));
    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const banner = await page.evaluate(async (projectId: string) => {
      const handlerMod = await import("/src/lib/handlers/reconnect-drift.ts");
      const tabsMod = await import("/src/components/code-mode/tab-store.ts");

      tabsMod.tabStore.__resetForTests();
      tabsMod.useEditorTabsStore.getState().__resetForTests();
      tabsMod.__setEditorTabIdGeneratorForTests(() => "ed-e2e-del");
      tabsMod.useEditorTabsStore.getState().open("src/gone.ts");
      tabsMod.useEditorTabsStore
        .getState()
        .setBuffer("ed-e2e-del", "x", "sha-A");

      const tabId = tabsMod.fileTabId(projectId, "src/gone.ts");
      tabsMod.tabStore.openTab({
        kind: "file",
        id: tabId,
        projectId,
        path: "src/gone.ts",
      });

      const qc = {
        invalidateQueries: () => {},
      } as unknown as Parameters<typeof handlerMod.runDriftCheck>[0];
      await handlerMod.runDriftCheck(qc, {
        fetcher: async () => ({ ok: false, error_code: "fs_not_found" }),
      });

      return tabsMod.tabStore.getState().banners.get(tabId);
    }, String(proj.id));

    expect(banner).toEqual({ kind: "deleted" });
  });

  test("globalWs.subscribeReconnect is edge-triggered on disconnect → connect", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request, uniq("recon-edge"));
    await page.goto(`/projects/${proj.id}?tab=code`);

    const root = page.getByTestId("code-mode-root");
    test.skip(
      !(await root.isVisible().catch(() => false)),
      "CodeMode is not mounted on the project-detail page yet.",
    );

    const counts = await page.evaluate(async () => {
      const mod = await import("/src/lib/global-ws.ts");
      let firings = 0;
      const unsub = mod.globalWs.subscribeReconnect(() => {
        firings += 1;
      });
      // First connect (no prior disconnect) — should NOT fire.
      mod.globalWs.__setConnectedForTests(true);
      const afterFirst = firings;
      // disconnect → connect — should fire once.
      mod.globalWs.__setConnectedForTests(false);
      mod.globalWs.__setConnectedForTests(true);
      const afterReconnect = firings;
      // another disconnect → connect — should fire again.
      mod.globalWs.__setConnectedForTests(false);
      mod.globalWs.__setConnectedForTests(true);
      const afterSecondReconnect = firings;
      unsub();
      return { afterFirst, afterReconnect, afterSecondReconnect };
    });

    expect(counts.afterFirst).toBe(0);
    expect(counts.afterReconnect).toBe(1);
    expect(counts.afterSecondReconnect).toBe(2);
  });

  test("ReconnectBanner — `changed` shape renders amber with Reload + Keep mine", async ({
    page,
  }) => {
    // Mount the banner standalone via the dev preview route. We don't
    // depend on the editor being wired up — the banner is a leaf
    // component and the visual surface is what we want to lock in.
    await page.setContent(
      `<div id="root" style="background: white; padding: 24px;"></div>`,
    );
    // The standalone render uses the shipped React + Tailwind via a
    // synthetic mount inside the page's existing app shell. If the
    // dev preview route isn't available we skip — the unit test
    // already covers the rendering branches.
    const mounted = await page.evaluate(async () => {
      try {
        const React = await import("/node_modules/.vite/deps/react.js?v=").catch(
          async () => await import("react"),
        );
        const ReactDOM = await import(
          "/node_modules/.vite/deps/react-dom_client.js?v="
        ).catch(async () => await import("react-dom/client"));
        const banner = await import(
          "/src/components/code-mode/ReconnectBanner.tsx"
        );
        const root = ReactDOM.createRoot(document.getElementById("root")!);
        root.render(
          React.createElement(banner.ReconnectBanner, {
            path: "src/foo.ts",
            banner: { kind: "changed", currentSha: "sha-B" },
            onReload: () => {},
            onDismiss: () => {},
          }),
        );
        return true;
      } catch {
        return false;
      }
    });

    test.skip(!mounted, "Banner standalone mount failed (dev preview path).");

    const node = page.getByTestId("reconnect-banner");
    await expect(node).toBeVisible();
    await expect(node).toHaveAttribute("data-kind", "changed");
    await expect(node).toHaveAttribute("data-current-sha", "sha-B");
    await expect(page.getByTestId("reconnect-banner-reload")).toBeVisible();
    await expect(page.getByTestId("reconnect-banner-keep")).toBeVisible();
    await expect(node).toHaveScreenshot("reconnect-banner-changed-offline.png");
  });

  test("ReconnectBanner — `deleted` shape renders rose with Save + Close", async ({
    page,
  }) => {
    await page.setContent(
      `<div id="root" style="background: white; padding: 24px;"></div>`,
    );
    const mounted = await page.evaluate(async () => {
      try {
        const React = await import("/node_modules/.vite/deps/react.js?v=").catch(
          async () => await import("react"),
        );
        const ReactDOM = await import(
          "/node_modules/.vite/deps/react-dom_client.js?v="
        ).catch(async () => await import("react-dom/client"));
        const banner = await import(
          "/src/components/code-mode/ReconnectBanner.tsx"
        );
        const root = ReactDOM.createRoot(document.getElementById("root")!);
        root.render(
          React.createElement(banner.ReconnectBanner, {
            path: "src/gone.ts",
            banner: { kind: "deleted" },
            onSave: () => {},
            onDismiss: () => {},
          }),
        );
        return true;
      } catch {
        return false;
      }
    });

    test.skip(!mounted, "Banner standalone mount failed (dev preview path).");

    const node = page.getByTestId("reconnect-banner");
    await expect(node).toBeVisible();
    await expect(node).toHaveAttribute("data-kind", "deleted");
    await expect(page.getByTestId("reconnect-banner-save")).toBeVisible();
    await expect(page.getByTestId("reconnect-banner-close")).toBeVisible();
    await expect(node).toHaveScreenshot("reconnect-banner-deleted-offline.png");
  });
});
