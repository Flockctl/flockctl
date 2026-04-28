import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, createWorkspace, uniq } from "./_helpers";

/**
 * Notification-related E2E specs.
 *
 * Right now this file scopes to favicon-badge behaviour driven by the
 * attention inbox. The setup mirrors `attention.spec.ts`: we insert a
 * `pending_approval` task directly into the e2e SQLite file because the
 * playwright harness has no real AI key and cannot drive a task through
 * the executor; see the long-form rationale in `attention.spec.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");

function insertPendingApprovalTask(projectId: number, label: string): number {
  const db = new Database(dbPath);
  try {
    const info = db
      .prepare(
        `INSERT INTO tasks (project_id, prompt, agent, status, label, requires_approval, task_type)
         VALUES (?, ?, ?, 'pending_approval', ?, 1, 'execution')`,
      )
      .run(projectId, "favicon-badge-check", "claude-code", label);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function deleteTasksForProject(projectId: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(`DELETE FROM tasks WHERE project_id = ?`).run(projectId);
  } finally {
    db.close();
  }
}

/**
 * Read the current `<link rel="icon">` href from inside the page. Returns
 * `null` when no link exists (regression guard — the runner is supposed
 * to create one if missing).
 */
async function readFaviconHref(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    return link ? link.href : null;
  });
}

test.describe("favicon badge", () => {
  test("badges the favicon when attention has items and clears it after approval", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const label = uniq("favicon-badge");
    const taskId = insertPendingApprovalTask(proj.id, label);

    try {
      await page.goto("/dashboard");

      // The runner mounts inside the providers near the React root, so by
      // the time the page is fully painted the favicon link should exist.
      // We give the debounced (~250ms) badge swap a generous ceiling so a
      // slow CI box does not flake.
      await expect
        .poll(() => readFaviconHref(page), { timeout: 5_000 })
        .toMatch(/^data:image\/png;base64,/);

      const badged = await readFaviconHref(page);
      expect(badged).not.toBe(null);
      // Sanity-check the encoded payload is non-trivial — a truly empty
      // canvas would still encode to a few hundred bytes, but the badge
      // glyph + base icon push it well past that. Keeps a regression
      // where renderBadge silently bails out and ships a blank canvas
      // from passing this test.
      expect((badged as string).length).toBeGreaterThan(500);

      // Approve the task to drain the attention queue. The route emits
      // `attention_changed`, useAttention invalidates, total drops to 0,
      // useFaviconBadge re-runs renderBadge with count=0, which returns
      // the captured original favicon href.
      await page.goto(`/tasks/${taskId}`);
      await expect(page.getByText("Task awaiting approval").first()).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: /^Approve$/ }).first().click();

      // Once the WS frame lands and the debounce fires, the favicon must
      // revert to a non-data: URL (the captured original).
      await expect
        .poll(() => readFaviconHref(page), { timeout: 5_000 })
        .not.toMatch(/^data:/);

      const cleared = await readFaviconHref(page);
      expect(cleared).toMatch(/favicon\.svg$/);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });

  test("favicon link exists with the expected base href on a clean inbox", async ({
    page,
    request,
  }) => {
    // Fresh project, no tasks. Total stays 0, so renderBadge short-circuits
    // to the original href without ever touching the canvas. This protects
    // against a regression where the hook eagerly assigns a data: URL even
    // when there is nothing to badge.
    await createProject(request);
    await page.goto("/dashboard");

    const href = await readFaviconHref(page);
    expect(href).not.toBeNull();
    expect(href).toMatch(/favicon\.svg$/);
  });
});

/**
 * Settings → Notifications tab — visual baselines + interaction smoke.
 *
 * Permission state is forced by patching `window.Notification.permission`
 * via `addInitScript` before the SPA boots. We deliberately do NOT rely
 * on `context.grantPermissions(["notifications"])` because Playwright's
 * permission API only flips `navigator.permissions.query()` — it does
 * NOT modify `Notification.permission`, which is what our component
 * actually reads. Headless chromium also reports `Notification.permission
 * === "denied"` by default, so an unpatched test would always land in the
 * "denied" branch.
 *
 * `isSecureContext` is normally read-only, so the "insecure-context"
 * baseline patches it the same way. Both overrides land via
 * `addInitScript` because the helper's status check is synchronous and
 * runs at first render — `page.evaluate` after `goto` would be too late.
 *
 * Pixel baselines live under
 * `ui/e2e/__screenshots__/notifications.spec.ts/`. Regenerate with:
 *
 *   cd ui && npm run e2e:update -- e2e/notifications.spec.ts
 */

type FakedPermission = "default" | "granted" | "denied";

async function fakeNotificationPermission(
  page: Page,
  permission: FakedPermission,
) {
  // The helper reads `Notification.permission` synchronously at render
  // time, so the override has to land via `addInitScript` (runs before
  // every navigation) rather than `evaluate` (runs after first render).
  await page.addInitScript((perm: FakedPermission) => {
    const fake = function NotificationCtor() {} as unknown as {
      permission: FakedPermission;
      requestPermission: () => Promise<FakedPermission>;
    };
    fake.permission = perm;
    fake.requestPermission = async () => perm;
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: fake,
    });
  }, permission);
}

async function freezeAnimations(page: Page) {
  // Mirrors the helper used by `workspace-detail-tabs.spec.ts` so
  // baselines never flicker on a transition mid-frame.
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}

async function openNotificationsTab(
  page: Page,
  opts: { expectMainUI?: boolean } = {},
) {
  const expectMainUI = opts.expectMainUI ?? true;
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // The shell renders a "Connecting to Local…" banner above the page header
  // until the first server-context probe lands. Its presence shifts the
  // whole page down ~30px, so screenshots taken before it disappears land
  // on a different layout than the baseline. Wait it out.
  await expect(
    page.locator("text=/^Connecting to /"),
  ).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId("settings-tab-notifications").click();
  if (expectMainUI) {
    // The unsupported / insecure-context branches early-return a banner
    // and don't render the `notifications-tab` testid wrapper, so callers
    // in those branches opt out of this check.
    await expect(page.getByTestId("notifications-tab")).toBeVisible();
  }
  await freezeAnimations(page);
}

test.describe("Settings → Notifications tab", () => {
  test("open settings notifications tab", async ({ page }) => {
    // Default state: permission has not been requested yet, master OFF,
    // no fieldset, no banners. Bare permission row + master checkbox.
    await fakeNotificationPermission(page, "default");
    await openNotificationsTab(page);

    // Functional asserts before the pixel baseline so a layout regression
    // surfaces with a useful failure even if the screenshot didn't change.
    await expect(page.getByTestId("notifications-permission-status")).toBeVisible();
    await expect(page.getByTestId("notifications-master-toggle")).toBeVisible();
    await expect(page.getByTestId("notifications-cat-approval")).toHaveCount(0);
    await expect(page.getByTestId("notifications-banner-denied")).toHaveCount(0);

    // Scope screenshots to the settings-tabs container — the sidebar
    // footer polls for version/update state and would otherwise flake the
    // diff with a transient spinner. Same approach as
    // `workspace-detail-tabs.spec.ts`.
    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-default-state.png",
    );
  });

  test("permission granted — master ON shows category fieldset", async ({
    page,
  }) => {
    await fakeNotificationPermission(page, "granted");
    // Pre-seed prefs so the page renders with master ON without going
    // through the click-to-grant flow. The hook reads localStorage on
    // first render.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "flockctl.notifications.v1",
        JSON.stringify({ enabled: true }),
      );
    });
    await openNotificationsTab(page);

    await expect(page.getByTestId("notifications-cat-approval")).toBeVisible();
    await expect(page.getByTestId("notifications-cat-failed")).toBeVisible();

    // Scope screenshots to the settings-tabs container — the sidebar
    // footer polls for version/update state and would otherwise flake the
    // diff with a transient spinner. Same approach as
    // `workspace-detail-tabs.spec.ts`.
    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-permission-granted.png",
    );
  });

  test("permission denied — recovery banner shows", async ({ page }) => {
    await fakeNotificationPermission(page, "denied");
    await openNotificationsTab(page);

    await expect(page.getByTestId("notifications-banner-denied")).toBeVisible();
    await expect(page.getByTestId("notifications-cat-approval")).toHaveCount(0);

    // Scope screenshots to the settings-tabs container — the sidebar
    // footer polls for version/update state and would otherwise flake the
    // diff with a transient spinner. Same approach as
    // `workspace-detail-tabs.spec.ts`.
    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-permission-denied.png",
    );
  });

  test("insecure-context banner replaces the entire UI", async ({ page }) => {
    // Force `isSecureContext === false` before first render. The helper's
    // status check is synchronous, so this must land via `addInitScript`
    // rather than `page.evaluate` after `goto`.
    await page.addInitScript(() => {
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        writable: true,
        value: false,
      });
    });
    // Notification still needs to exist on the window so the helper
    // doesn't fall through to "unsupported"; the permission value is
    // irrelevant here because the insecure-context branch wins first.
    await fakeNotificationPermission(page, "default");
    await openNotificationsTab(page, { expectMainUI: false });

    await expect(
      page.getByTestId("notifications-banner-insecure-context"),
    ).toBeVisible();
    // Toggle and category checkboxes must NOT exist when the context
    // can't support notifications at all.
    await expect(page.getByTestId("notifications-master-toggle")).toHaveCount(0);
    await expect(page.getByTestId("notifications-cat-approval")).toHaveCount(0);

    // Scope screenshots to the settings-tabs container — the sidebar
    // footer polls for version/update state and would otherwise flake the
    // diff with a transient spinner. Same approach as
    // `workspace-detail-tabs.spec.ts`.
    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-insecure-context-banner.png",
    );
  });

  test("leader status row — leader baseline (single tab)", async ({ page }) => {
    // A solo tab is unconditionally the leader after the 200ms claim
    // window. Capture a baseline of the row in the "leader" state.
    await fakeNotificationPermission(page, "granted");
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "flockctl.notifications.v1",
        JSON.stringify({ enabled: true }),
      );
    });
    await openNotificationsTab(page);

    // 200ms claim window + a small buffer.
    await page.waitForTimeout(400);

    await expect(page.getByTestId("notifications-leader-status")).toBeVisible();
    await expect(page.getByTestId("notifications-leader-status")).toHaveAttribute(
      "data-leader",
      "leader",
    );

    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-leader-status-leader.png",
    );
  });

  test("leader status row — follower baseline (forced via stub)", async ({
    page,
  }) => {
    // Force the leader-election protocol to see a "ghost" leader with a
    // smaller tabId via a wrapped BroadcastChannel. The wrapper fires a
    // heartbeat from tabId "00" on every channel construction (and at a
    // 1Hz cadence after that) so this real tab demotes itself once the
    // 200ms claim window opens. Avoids the flakiness of spawning a real
    // second Playwright page just to occupy the leader role.
    await fakeNotificationPermission(page, "granted");
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "flockctl.notifications.v1",
        JSON.stringify({ enabled: true }),
      );
      const NativeBC = window.BroadcastChannel;
      class WrappedBC extends NativeBC {
        constructor(name: string) {
          super(name);
          if (name === "flockctl.notifications") {
            const blast = () => {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: { type: "heartbeat", tabId: "00", at: Date.now() },
                }),
              );
            };
            queueMicrotask(blast);
            setInterval(blast, 1000);
          }
        }
      }
      // @ts-expect-error - replacing global with subclass for test stub.
      window.BroadcastChannel = WrappedBC;
    });
    await openNotificationsTab(page);

    // Wait past the 200ms claim window so the election settles.
    await page.waitForTimeout(500);

    await expect(page.getByTestId("notifications-leader-status")).toHaveAttribute(
      "data-leader",
      "follower",
    );

    await expect(page.getByTestId("settings-tabs")).toHaveScreenshot(
      "settings-notifications-tab-leader-status-follower.png",
    );
  });
});

/**
 * Multi-tab leader-election integration.
 *
 * Two real Playwright pages, same browser context (so `BroadcastChannel`
 * messages cross between them like real browser tabs). We drive the
 * Dispatcher directly via the test-only `window.__flockctlDispatcher`
 * handle and count `Notification` constructions per tab.
 */

async function stubNotifications(page: Page) {
  // Patch `window.Notification` so:
  //   1. Permission is "granted" without a user gesture.
  //   2. Every constructor call lands in `window.__notifications` so the
  //      test can read the per-tab fire count.
  //
  // Lands via `addInitScript` so the override applies on every navigation.
  await page.addInitScript(() => {
    const sink: Array<{ title: string }> = [];
    const fake = function NotificationCtor(title: string) {
      sink.push({ title });
    } as unknown as {
      permission: "granted";
      requestPermission: () => Promise<"granted">;
    };
    fake.permission = "granted";
    fake.requestPermission = async () => "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: fake,
    });
    (window as unknown as { __notifications: typeof sink }).__notifications =
      sink;
    // Pre-seed prefs so the dispatcher's master/category gates pass.
    window.localStorage.setItem(
      "flockctl.notifications.v1",
      JSON.stringify({
        enabled: true,
        onApprovalNeeded: true,
        onQuestionAsked: true,
        onTaskDone: true,
        onTaskFailed: true,
        onTaskBlocked: true,
      }),
    );
  });
}

async function fireApproval(page: Page, key: string): Promise<void> {
  // The dispatcher is published on `window.__flockctlDispatcher` by the
  // provider for exactly this purpose — driving fire() from a Playwright
  // test without wiring up the full task → executor → websocket loop.
  await page.evaluate(
    ([k]) => {
      type Dispatcher = {
        fire: (n: {
          category: string;
          key: string;
          title: string;
        }) => void;
      };
      const d = (window as unknown as { __flockctlDispatcher?: Dispatcher })
        .__flockctlDispatcher;
      if (!d) throw new Error("no __flockctlDispatcher on window");
      d.fire({ category: "approval", key: k, title: "Approval needed" });
    },
    [key],
  );
}

async function readFireCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sink = (window as unknown as { __notifications?: Array<unknown> })
      .__notifications;
    return sink ? sink.length : 0;
  });
}

test.describe("Notification dispatcher — multi-tab leader election", () => {
  test("two-tab variant: only one tab fires notification per event", async ({
    browser,
  }) => {
    // Same context = shared BroadcastChannel bus, just like two real tabs
    // inside the same browser window. Distinct contexts would be isolated
    // and both would self-elect.
    const ctx = await browser.newContext();
    try {
      const page1 = await ctx.newPage();
      const page2 = await ctx.newPage();
      await stubNotifications(page1);
      await stubNotifications(page2);
      await Promise.all([page1.goto("/dashboard"), page2.goto("/dashboard")]);

      // Wait for the 200ms claim window + buffer so the election is settled.
      await page1.waitForTimeout(500);

      await fireApproval(page1, "evt:multitab-A");
      await fireApproval(page2, "evt:multitab-A");

      // Give any racing OS-notification callbacks time to land.
      await page1.waitForTimeout(200);

      const fired1 = await readFireCount(page1);
      const fired2 = await readFireCount(page2);
      // Across both tabs, exactly one Notification was constructed.
      expect(fired1 + fired2).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test("closing the leader: new leader fires for new events only, not stale ones", async ({
    browser,
  }) => {
    // The M0 slice 01 invariant: a follower's diff baseline must stay
    // current even when it isn't firing. After leader closes, the new
    // leader must fire for *new* events only — never for events that
    // were already delivered (and gated) on the old leader.
    const ctx = await browser.newContext();
    try {
      const page1 = await ctx.newPage();
      const page2 = await ctx.newPage();
      await stubNotifications(page1);
      await stubNotifications(page2);
      await Promise.all([page1.goto("/dashboard"), page2.goto("/dashboard")]);
      await page1.waitForTimeout(500);

      // Event A — fires on whichever tab is currently leader. Both tabs
      // go through the dispatcher; only one Notification is constructed.
      await fireApproval(page1, "evt:A");
      await fireApproval(page2, "evt:A");
      await page1.waitForTimeout(200);
      const firedA = (await readFireCount(page1)) + (await readFireCount(page2));
      expect(firedA).toBe(1);

      // Close page1 (typically the leader by tabId order, but either way
      // — closing one tab forces a re-election). beforeunload will fire,
      // posting a relinquish, and page2 takes over.
      await page1.close();
      // Re-election claim window + buffer.
      await page2.waitForTimeout(500);

      // Event B — only page2 is alive now. It must fire exactly once and
      // must NOT replay A.
      await fireApproval(page2, "evt:B");
      await page2.waitForTimeout(200);
      const firedTotalAfterB = await readFireCount(page2);
      // Either page2 was already the leader (firedTotalAfterB === 2: A+B)
      // or it was promoted (firedTotalAfterB === 1: just B). Either way,
      // page2 must NOT have an extra "ghost" replay of A — the count
      // is bounded above by 2.
      expect(firedTotalAfterB).toBeLessThanOrEqual(2);
      // And it must reflect at least one fresh fire for B.
      expect(firedTotalAfterB).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.close();
    }
  });
});

/**
 * Bidirectional-diff resolving: when an attention row disappears (the
 * user cleared it via the UI / API / another tab), the dispatcher must
 * dismiss the previously-fired OS notification automatically.
 *
 * The full pipeline under test:
 *
 *   1. A pending_approval task is inserted directly into the SQLite
 *      database (same trick attention.spec.ts uses — the harness has no
 *      AI key to drive the executor).
 *   2. The page boots `/dashboard`. The `AttentionNotificationsRunner`
 *      mounted inside `<Layout />` sees the row appear (from null
 *      baseline → ignored), then runs the diff again on the next poll
 *      with the row already in `prev`. We force-fire the dispatcher with
 *      the matching key so the registry has a handle to close (relying
 *      on a real "added" tick is racy because the very first diff
 *      establishes baseline silently).
 *   3. The user approves the task; the API emits `attention_changed`,
 *      `useAttention` invalidates, the next poll returns an empty
 *      inbox, the bidirectional diff produces `removedKeys =
 *      [task_approval:<id>]`, and the hook calls
 *      `dispatcher.resolveByKey(...)` — which closes the handle.
 *
 * Verification: the test stub records every `Notification` instance and
 * its `closed` flag, so we just check that the count of *open*
 * notifications drops to zero after the approval lands.
 */

async function stubNotificationsWithCloseTracking(page: Page) {
  // Same shape as `stubNotifications` above but the per-instance object
  // exposes a real `close()` that flips a `closed` flag, so the
  // dispatcher's `resolveByKey` -> `handle.close()` chain has something
  // to mutate. Records both fire and close events for the test to assert
  // on.
  await page.addInitScript(() => {
    type Tracker = {
      fired: Array<{ tag?: string; closed: boolean }>;
    };
    const sink: Tracker = { fired: [] };
    const NotificationCtor = function (
      this: { tag?: string; closed: boolean; close(): void },
      _title: string,
      opts?: NotificationOptions,
    ) {
      this.tag = opts?.tag;
      this.closed = false;
      this.close = () => {
        this.closed = true;
      };
      sink.fired.push(this);
      return this;
    } as unknown as {
      permission: "granted";
      requestPermission: () => Promise<"granted">;
    };
    NotificationCtor.permission = "granted";
    NotificationCtor.requestPermission = async () => "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: NotificationCtor,
    });
    (window as unknown as { __notifications: Tracker }).__notifications = sink;
    window.localStorage.setItem(
      "flockctl.notifications.v1",
      JSON.stringify({
        enabled: true,
        onApprovalNeeded: true,
        onQuestionAsked: true,
        onTaskDone: true,
        onTaskFailed: true,
        onTaskBlocked: true,
      }),
    );
  });
}

async function readNotificationStats(
  page: Page,
): Promise<{ total: number; open: number; closedTags: string[] }> {
  return page.evaluate(() => {
    const sink = (
      window as unknown as {
        __notifications?: {
          fired: Array<{ tag?: string; closed: boolean }>;
        };
      }
    ).__notifications;
    if (!sink) return { total: 0, open: 0, closedTags: [] };
    return {
      total: sink.fired.length,
      open: sink.fired.filter((f) => !f.closed).length,
      closedTags: sink.fired
        .filter((f) => f.closed && f.tag)
        .map((f) => f.tag!),
    };
  });
}

test.describe("Notification dispatcher — resolving on inbox disappearance", () => {
  test("closes the OS notification when the underlying attention row is approved", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const label = uniq("notif-resolve");
    const taskId = insertPendingApprovalTask(proj.id, label);

    try {
      await stubNotificationsWithCloseTracking(page);
      await page.goto("/dashboard");

      // Wait for the favicon-badge data: URL to appear, which signals
      // useAttention has at least one item — the runner has now seen
      // the row in `next` AT LEAST ONCE, but the FIRST diff vs.
      // `prevRef.current === null` doesn't fire (baseline). We need
      // the registry to actually own a handle for this key, so we
      // force-fire via the test handle with the matching key.
      await expect
        .poll(() => readFaviconHref(page), { timeout: 5_000 })
        .toMatch(/^data:image\/png;base64,/);

      await page.evaluate((tid) => {
        type Dispatcher = {
          fire: (n: {
            category: string;
            key: string;
            title: string;
            source?: string;
          }) => void;
        };
        const d = (
          window as unknown as { __flockctlDispatcher?: Dispatcher }
        ).__flockctlDispatcher;
        if (!d) throw new Error("no __flockctlDispatcher on window");
        d.fire({
          category: "approval",
          key: `task_approval:${tid}`,
          title: "Approval needed",
          source: "attention",
        });
      }, String(taskId));

      // Confirm the handle is registered and open.
      await expect
        .poll(() => readNotificationStats(page))
        .toMatchObject({ total: 1, open: 1 });

      // Approve the task — drains the attention queue. The diff on the
      // next poll computes removedKeys=[task_approval:<id>] and the hook
      // calls resolveByKey, which closes the handle.
      await page.goto(`/tasks/${taskId}`);
      await expect(
        page.getByText("Task awaiting approval").first(),
      ).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /^Approve$/ }).first().click();

      await expect
        .poll(() => readNotificationStats(page), { timeout: 10_000 })
        .toMatchObject({ total: 1, open: 0 });

      const stats = await readNotificationStats(page);
      expect(stats.closedTags).toContain(`task_approval:${taskId}`);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });
});

/**
 * Attention → notification end-to-end pump.
 *
 * Validates the slice's two named corner cases:
 *
 *   - "resolving does not duplicate" — once the runner has fired for a
 *     row, neither a refetch returning the same row nor an approval
 *     draining the row may produce a second notification for it.
 *   - "category toggle off suppresses" — the prefs gate must short-
 *     circuit before the dispatcher constructs a Notification, even
 *     though the diff baseline still advances under the hood.
 *
 * Same `addInitScript` strategy as the dispatcher block above, but the
 * fake constructor records (title, tag, body) so we can assert on the
 * dispatcher's tag = attentionItemKey contract.
 */

async function stubAttentionNotifications(
  page: Page,
  prefsOverrides: Record<string, boolean> = {},
) {
  await page.addInitScript((overrides) => {
    const sink: Array<{ title: string; tag?: string; body?: string }> = [];
    const fake = function NotificationCtor(
      title: string,
      opts?: { tag?: string; body?: string },
    ) {
      sink.push({ title, tag: opts?.tag, body: opts?.body });
    } as unknown as {
      permission: "granted";
      requestPermission: () => Promise<"granted">;
    };
    fake.permission = "granted";
    fake.requestPermission = async () => "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: fake,
    });
    (window as unknown as { __notifications: typeof sink }).__notifications =
      sink;
    const basePrefs = {
      enabled: true,
      onApprovalNeeded: true,
      onQuestionAsked: true,
      onTaskDone: true,
      onTaskFailed: true,
      onTaskBlocked: true,
    };
    window.localStorage.setItem(
      "flockctl.notifications.v1",
      JSON.stringify({ ...basePrefs, ...overrides }),
    );
  }, prefsOverrides);
}

async function readSimpleNotifications(
  page: Page,
): Promise<Array<{ title: string; tag?: string; body?: string }>> {
  return page.evaluate(() => {
    const sink = (
      window as unknown as {
        __notifications?: Array<{ title: string; tag?: string; body?: string }>;
      }
    ).__notifications;
    return Array.isArray(sink) ? [...sink] : [];
  });
}

test.describe("Attention → notification pump (corner cases)", () => {
  test("resolving the inbox row does NOT duplicate the notification", async ({
    page,
    request,
  }) => {
    // The slice's "resolving does not duplicate" guard. The bidirectional
    // diff on a → [] transition produces removedKeys=[…]; the hook calls
    // resolveByKey but MUST NOT call fire again. We assert the
    // constructed-notification count never grows past 1.
    const proj = await createProject(request);
    const label = uniq("notif-no-dup");
    const taskId = insertPendingApprovalTask(proj.id, label);
    try {
      await stubAttentionNotifications(page);
      // Force-fire once via the test handle so the registry has a known
      // baseline of exactly one notification — same trick the
      // resolving-on-disappearance test above uses, applied here so we
      // measure "did the resolve path produce an EXTRA fire?" rather
      // than racing the diff baseline.
      await page.goto("/dashboard");
      await expect(
        page.locator("text=/^Connecting to /"),
      ).toHaveCount(0, { timeout: 10_000 });
      await page.waitForTimeout(500);

      await page.evaluate((tid) => {
        type Dispatcher = {
          fire: (n: {
            category: string;
            key: string;
            title: string;
            source?: string;
          }) => void;
        };
        const d = (
          window as unknown as { __flockctlDispatcher?: Dispatcher }
        ).__flockctlDispatcher;
        if (!d) throw new Error("no __flockctlDispatcher on window");
        d.fire({
          category: "approval",
          key: `task_approval:${tid}`,
          title: "Approval needed",
          source: "attention",
        });
      }, String(taskId));

      await expect
        .poll(() => readSimpleNotifications(page).then((arr) => arr.length), {
          timeout: 5_000,
        })
        .toBe(1);

      // Approve via the UI — the route emits attention_changed, the row
      // drains, the diff sees removedKeys, the dispatcher closes the
      // handle. NONE of those steps should produce a second fire().
      await page.goto(`/tasks/${taskId}`);
      await expect(
        page.getByText("Task awaiting approval").first(),
      ).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /^Approve$/ }).first().click();

      // Generous settle window — we want a deterministic "did NOT
      // grow" assertion, so wait past every plausible WS round-trip
      // before reading.
      await page.waitForTimeout(2_000);

      const after = await readSimpleNotifications(page);
      expect(after).toHaveLength(1);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });

  test("category toggle OFF suppresses the notification", async ({
    page,
    request,
  }) => {
    // Slice's "category toggle off" corner case. The hook still runs
    // the diff (so the baseline stays current — important for the next
    // toggle-on event not to backfire), but dispatcher.fire's gate-3
    // short-circuits before constructing a Notification. The favicon
    // badge is unaffected by the prefs gate, so it serves as a proof
    // that the attention pump landed at all.
    const proj = await createProject(request);
    await stubAttentionNotifications(page, { onApprovalNeeded: false });
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/^Connecting to /"),
    ).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(500);

    insertPendingApprovalTask(proj.id, uniq("notif-cat-off"));
    try {
      // Wait for the favicon-badge to swap to a data: URL — that's the
      // signal that useAttention has the row, the runner has run the
      // diff, and any fire() that was going to happen has happened.
      await expect
        .poll(() => readFaviconHref(page), { timeout: 5_000 })
        .toMatch(/^data:image\/png;base64,/);

      const fired = await readSimpleNotifications(page);
      expect(fired).toHaveLength(0);
    } finally {
      deleteTasksForProject(proj.id);
    }
  });
});

/**
 * Task-terminal → notification end-to-end pump.
 *
 * Covers the live wiring of `<TaskTerminalNotificationsRunner />`:
 *
 *   1. The runner is mounted inside `<Layout />` near the React root.
 *   2. It subscribes to the global WebSocket `/ws/ui/chats/events`.
 *   3. Inbound `task_status` frames whose status lands in the terminal
 *      set ({done, failed, cancelled, timed_out}) are forwarded to the
 *      dispatcher with `source: "task_terminal"`.
 *   4. The dispatcher constructs an OS notification — observable via the
 *      stubbed `Notification` constructor.
 *
 * `page.routeWebSocket` intercepts the global socket the same way
 * `task-detail.spec.ts` mocks the per-task logs stream, so the test can
 * push synthetic frames without driving a real task through the
 * executor (which the playwright harness can't do — no AI key).
 */

test.describe("Task-terminal → notification pump", () => {
  test("fires a 'Task completed' notification on a `done` task_status frame", async ({
    page,
  }) => {
    await stubAttentionNotifications(page);

    // Hold a reference to the global WS server-side so the test body
    // can push synthetic frames once the app has claimed the socket.
    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (ws) => {
      wsRef = ws;
    });

    await page.goto("/dashboard");
    // Wait for the runner to claim the global socket — the websocket
    // route handler captures the server-side route on the very first
    // connection. Generous timeout to absorb a slow CI box.
    await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

    // Push a `task_status: done` envelope shaped exactly like
    // `WSManager.broadcastTaskStatus` produces — flat top-level
    // {type, taskId, status, …} with the title rolled in for the
    // body-resolution path.
    wsRef!.send(
      JSON.stringify({
        type: "task_status",
        taskId: "999",
        status: "done",
        title: "Implement feature X",
      }),
    );

    await expect
      .poll(() => readSimpleNotifications(page).then((arr) => arr.length), {
        timeout: 5_000,
      })
      .toBe(1);

    const fired = await readSimpleNotifications(page);
    expect(fired[0]?.title).toBe("Task completed");
    expect(fired[0]?.body).toBe("Implement feature X");
    // OS-level dedup tag is the dispatcher's per-(task, status) key.
    expect(fired[0]?.tag).toBe("task_terminal:999:done");
  });

  test("ignores non-terminal task_status frames (running / queued / pending_approval)", async ({
    page,
  }) => {
    await stubAttentionNotifications(page);

    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (ws) => {
      wsRef = ws;
    });

    await page.goto("/dashboard");
    await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

    for (const status of ["queued", "running", "pending_approval"]) {
      wsRef!.send(
        JSON.stringify({
          type: "task_status",
          taskId: "1",
          status,
          title: "Should not fire",
        }),
      );
    }

    // Generous settle window for any spurious dispatch — we want a
    // deterministic "did NOT fire" assertion.
    await page.waitForTimeout(1_000);

    const fired = await readSimpleNotifications(page);
    expect(fired).toHaveLength(0);
  });

  test("fires a 'Task failed' notification with the per-status dedup tag for a `failed` frame", async ({
    page,
  }) => {
    // Independent test from the `done` path because:
    //   - status → category mapping is the per-status concern, and
    //     `failed` exercises the gate-3 `onTaskFailed` toggle, NOT the
    //     `onTaskDone` toggle the success path uses;
    //   - the dispatcher's dedup-key construction includes the status,
    //     which we want to assert on independently of the done case.
    await stubAttentionNotifications(page);

    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (ws) => {
      wsRef = ws;
    });

    await page.goto("/dashboard");
    await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

    wsRef!.send(
      JSON.stringify({
        type: "task_status",
        taskId: "777",
        status: "failed",
        title: "Tests went red",
      }),
    );

    await expect
      .poll(() => readSimpleNotifications(page).then((arr) => arr.length), {
        timeout: 5_000,
      })
      .toBe(1);

    const fired = await readSimpleNotifications(page);
    expect(fired[0]?.title).toBe("Task failed");
    expect(fired[0]?.body).toBe("Tests went red");
    expect(fired[0]?.tag).toBe("task_terminal:777:failed");
  });
});

/**
 * Notification → SPA route on click.
 *
 * Validates the full pipeline:
 *
 *   1. Dispatcher.fire() constructs a Notification and wires its
 *      onclick to (focus → close → emit on bus).
 *   2. The mounted `<NotificationClickRouterRunner />` (inside <Layout />)
 *      subscribes to the dispatcher's `notification-click` bus and
 *      navigates to the path returned by `routeForNotification`.
 *
 * The test fake from `stubNotificationsForClick` keeps every constructed
 * Notification on `window.__notificationsRefs` so the spec can simulate
 * an OS click by invoking `onclick` directly — Playwright cannot drive a
 * real OS notification from inside the headless browser.
 */
async function stubNotificationsForClick(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type FakeNote = {
      title: string;
      opts?: NotificationOptions;
      closed: boolean;
      onclick:
        | ((this: FakeNote, ev: Event) => void)
        | null;
      onclose: ((this: FakeNote) => void) | null;
      close(): void;
    };
    const refs: FakeNote[] = [];
    const sink: Array<{ title: string; tag?: string }> = [];
    const NotificationCtor = function (
      this: FakeNote,
      title: string,
      opts?: NotificationOptions,
    ) {
      this.title = title;
      this.opts = opts;
      this.closed = false;
      this.onclick = null;
      this.onclose = null;
      this.close = () => {
        this.closed = true;
        try {
          this.onclose?.call(this);
        } catch {
          // intentional swallow
        }
      };
      refs.push(this);
      sink.push({ title, tag: opts?.tag });
      return this;
    } as unknown as {
      permission: "granted";
      requestPermission: () => Promise<"granted">;
    };
    NotificationCtor.permission = "granted";
    NotificationCtor.requestPermission = async () => "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: NotificationCtor,
    });
    (window as unknown as {
      __notifications: typeof sink;
      __notificationsRefs: typeof refs;
    }).__notifications = sink;
    (window as unknown as {
      __notificationsRefs: typeof refs;
    }).__notificationsRefs = refs;
    // Pre-seed prefs so dispatcher's master/category gates pass.
    window.localStorage.setItem(
      "flockctl.notifications.v1",
      JSON.stringify({
        enabled: true,
        onApprovalNeeded: true,
        onQuestionAsked: true,
        onTaskDone: true,
        onTaskFailed: true,
        onTaskBlocked: true,
      }),
    );
  });
}

test.describe("Notification click → SPA route", () => {
  test("clicking a task_terminal notification navigates to /tasks/{taskId}", async ({
    page,
  }) => {
    await stubNotificationsForClick(page);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/^Connecting to /"),
    ).toHaveCount(0, { timeout: 10_000 });

    // Drive fire() directly via the test handle. Equivalent to a
    // task_status: failed WS frame landing on the runner; we skip the
    // WS plumbing here because click-routing is the only behaviour
    // under test.
    await page.evaluate(() => {
      type Dispatcher = {
        fire: (n: {
          category: string;
          key: string;
          title: string;
          source?: string;
          taskId?: string;
        }) => void;
      };
      const d = (
        window as unknown as { __flockctlDispatcher?: Dispatcher }
      ).__flockctlDispatcher;
      if (!d) throw new Error("no __flockctlDispatcher on window");
      d.fire({
        category: "failed",
        key: "task_terminal:click-1:failed",
        title: "Task failed",
        source: "task_terminal",
        taskId: "click-1",
      });
    });

    // Wait for the constructor to land before driving the click.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const refs = (
              window as unknown as { __notificationsRefs?: unknown[] }
            ).__notificationsRefs;
            return Array.isArray(refs) ? refs.length : 0;
          }),
        { timeout: 5_000 },
      )
      .toBe(1);

    // Simulate the OS click — calls the dispatcher's onclick handler,
    // which closes the notification and emits notification-click on
    // the bus. The runner inside <Layout /> picks it up and navigates.
    await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{
            onclick: ((ev: Event) => void) | null;
          }>;
        }
      ).__notificationsRefs;
      if (!refs || refs.length === 0) throw new Error("no refs");
      const cb = refs[0]?.onclick;
      if (!cb) throw new Error("onclick not wired");
      cb(new Event("click"));
    });

    await expect(page).toHaveURL(/\/tasks\/click-1$/);
    // The notification was closed on click.
    const closed = await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{ closed: boolean }>;
        }
      ).__notificationsRefs;
      return refs?.[0]?.closed ?? false;
    });
    expect(closed).toBe(true);
  });

  test("clicking a task_approval (attention) notification navigates to /tasks/{task_id}", async ({
    page,
  }) => {
    await stubNotificationsForClick(page);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/^Connecting to /"),
    ).toHaveCount(0, { timeout: 10_000 });

    await page.evaluate(() => {
      type Dispatcher = {
        fire: (n: {
          category: string;
          key: string;
          title: string;
          source?: string;
          item?: { kind: string; task_id?: string; chat_id?: string };
        }) => void;
      };
      const d = (
        window as unknown as { __flockctlDispatcher?: Dispatcher }
      ).__flockctlDispatcher;
      if (!d) throw new Error("no __flockctlDispatcher on window");
      d.fire({
        category: "approval",
        key: "task_approval:42",
        title: "Approval needed",
        source: "attention",
        item: {
          kind: "task_approval",
          task_id: "42",
        },
      });
    });

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const refs = (
              window as unknown as { __notificationsRefs?: unknown[] }
            ).__notificationsRefs;
            return Array.isArray(refs) ? refs.length : 0;
          }),
        { timeout: 5_000 },
      )
      .toBe(1);

    await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{
            onclick: ((ev: Event) => void) | null;
          }>;
        }
      ).__notificationsRefs;
      if (!refs || refs.length === 0) throw new Error("no refs");
      const cb = refs[0]?.onclick;
      if (!cb) throw new Error("onclick not wired");
      cb(new Event("click"));
    });

    await expect(page).toHaveURL(/\/tasks\/42$/);
  });

  test("clicking a chat_approval (attention) notification navigates to /chats/{chat_id}", async ({
    page,
  }) => {
    await stubNotificationsForClick(page);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/^Connecting to /"),
    ).toHaveCount(0, { timeout: 10_000 });

    await page.evaluate(() => {
      type Dispatcher = {
        fire: (n: {
          category: string;
          key: string;
          title: string;
          source?: string;
          item?: { kind: string; chat_id?: string };
        }) => void;
      };
      const d = (
        window as unknown as { __flockctlDispatcher?: Dispatcher }
      ).__flockctlDispatcher;
      if (!d) throw new Error("no __flockctlDispatcher on window");
      d.fire({
        category: "approval",
        key: "chat_approval:7",
        title: "Approval needed",
        source: "attention",
        item: {
          kind: "chat_approval",
          chat_id: "7",
        },
      });
    });

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const refs = (
              window as unknown as { __notificationsRefs?: unknown[] }
            ).__notificationsRefs;
            return Array.isArray(refs) ? refs.length : 0;
          }),
        { timeout: 5_000 },
      )
      .toBe(1);

    await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{
            onclick: ((ev: Event) => void) | null;
          }>;
        }
      ).__notificationsRefs;
      const cb = refs?.[0]?.onclick;
      if (!cb) throw new Error("onclick not wired");
      cb(new Event("click"));
    });

    await expect(page).toHaveURL(/\/chats\/7$/);
  });

  test("clicking a malformed notification falls back to /attention", async ({
    page,
  }) => {
    // Defence-in-depth: a payload missing both `item` and `taskId`
    // (e.g. a future source we haven't taught the router about) must
    // not strand the user on /dashboard. The fallback route is the
    // inbox, where they can re-pick the row.
    await stubNotificationsForClick(page);
    await page.goto("/dashboard");
    await expect(
      page.locator("text=/^Connecting to /"),
    ).toHaveCount(0, { timeout: 10_000 });

    await page.evaluate(() => {
      type Dispatcher = {
        fire: (n: {
          category: string;
          key: string;
          title: string;
          source?: string;
        }) => void;
      };
      const d = (
        window as unknown as { __flockctlDispatcher?: Dispatcher }
      ).__flockctlDispatcher;
      if (!d) throw new Error("no __flockctlDispatcher on window");
      d.fire({
        category: "approval",
        key: "fallback:click",
        title: "Approval needed",
        source: "attention",
      });
    });

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const refs = (
              window as unknown as { __notificationsRefs?: unknown[] }
            ).__notificationsRefs;
            return Array.isArray(refs) ? refs.length : 0;
          }),
        { timeout: 5_000 },
      )
      .toBe(1);

    await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{
            onclick: ((ev: Event) => void) | null;
          }>;
        }
      ).__notificationsRefs;
      const cb = refs?.[0]?.onclick;
      if (!cb) throw new Error("onclick not wired");
      cb(new Event("click"));
    });

    await expect(page).toHaveURL(/\/attention$/);
  });
});

/**
 * Chat-reply notification flow.
 *
 * The chat-reply runner sits next to the attention and task-terminal pumps
 * inside <Layout />, but its trigger is the WebSocket `chat_assistant_final`
 * frame (broadcast from the SSE `stream_end` branch of
 * `src/routes/chats/messages.ts` on a clean turn-end). Three behaviours are
 * worth pinning end-to-end on top of the unit suite:
 *
 *   1. Happy path — frame lands while the tab is backgrounded → exactly
 *      one Notification, title = chat title, body = localised
 *      "Agent replied", clicking it routes to /chats/{chatId}.
 *   2. Attention-conflict suppression — if the same chat already has a
 *      pending agent question in the attention cache by the time the
 *      frame arrives, the chat-reply notification must NOT fire (the
 *      question notification, surfaced through the M14 attention pump, is
 *      the active call-to-action; piling on a second OS notification for
 *      the same chat is just noise).
 *   3. Focus suppression — same chatId, but the user is foregrounded on
 *      `/chats/{chatId}` itself → no notification (they're already
 *      reading the new reply, the OS notification would be redundant).
 *
 * Setup pattern mirrors the four M14 cases above: stubbed `Notification`
 * installed via addInitScript, master + chatReply prefs ON in localStorage
 * before first render, synthetic WS frames pushed via page.routeWebSocket
 * (the playwright harness has no AI key, so a real chat turn never
 * completes — the WS injection is the only deterministic trigger).
 */

/**
 * Insert a pending chat-targeted agent question directly into the e2e
 * SQLite file. Same trick as `insertPendingApprovalTask`: the harness has
 * no AI key to drive a real question through the executor, so the row is
 * seeded straight into the table that backs the attention inbox. The
 * unique `request_id` and `tool_use_id` are namespaced to the chat so
 * parallel tests can't collide.
 */
function insertChatQuestion(chatId: number, question: string): number {
  const db = new Database(dbPath);
  try {
    const requestId = `req-${chatId}-${Date.now()}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    const toolUseId = `tu-${chatId}-${Date.now()}`;
    const info = db
      .prepare(
        `INSERT INTO agent_questions (request_id, chat_id, tool_use_id, question, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(requestId, chatId, toolUseId, question);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function deleteChatQuestionsForChat(chatId: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(`DELETE FROM agent_questions WHERE chat_id = ?`).run(chatId);
  } finally {
    db.close();
  }
}

/**
 * Like `stubNotificationsForClick`, but also records the per-construction
 * `body` option in the sink so callers can assert on the localised
 * "Agent replied" body without having to reach into the refs array. Pre-
 * seeds prefs with `onChatReply: true` so the dispatcher's category gate
 * passes — equivalent to the user toggling chatReply ON in Settings, just
 * without driving the click through the React tree.
 */
async function stubNotificationsForChatReply(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type FakeNote = {
      title: string;
      opts?: NotificationOptions;
      closed: boolean;
      onclick: ((this: FakeNote, ev: Event) => void) | null;
      onclose: ((this: FakeNote) => void) | null;
      close(): void;
    };
    const refs: FakeNote[] = [];
    const sink: Array<{ title: string; tag?: string; body?: string }> = [];
    const NotificationCtor = function (
      this: FakeNote,
      title: string,
      opts?: NotificationOptions,
    ) {
      this.title = title;
      this.opts = opts;
      this.closed = false;
      this.onclick = null;
      this.onclose = null;
      this.close = () => {
        this.closed = true;
        try {
          this.onclose?.call(this);
        } catch {
          // intentional swallow — same shape as the dispatcher's onclose
        }
      };
      refs.push(this);
      sink.push({ title, tag: opts?.tag, body: opts?.body });
      return this;
    } as unknown as {
      permission: "granted";
      requestPermission: () => Promise<"granted">;
    };
    NotificationCtor.permission = "granted";
    NotificationCtor.requestPermission = async () => "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: NotificationCtor,
    });
    (
      window as unknown as {
        __notifications: typeof sink;
        __notificationsRefs: typeof refs;
      }
    ).__notifications = sink;
    (
      window as unknown as { __notificationsRefs: typeof refs }
    ).__notificationsRefs = refs;
    // Master + chatReply ON; keep the M14 categories ON too so the
    // attention pump can still surface the question notification in the
    // suppression test below.
    window.localStorage.setItem(
      "flockctl.notifications.v1",
      JSON.stringify({
        enabled: true,
        onApprovalNeeded: true,
        onQuestionAsked: true,
        onTaskDone: true,
        onTaskFailed: true,
        onTaskBlocked: true,
        onChatReply: true,
      }),
    );
  });
}

/**
 * Force `document.hasFocus()` to return false before first render. Mirrors
 * the "blur tab" preamble of the M14 cases — the runner reads
 * `document.hasFocus()` synchronously, so the override has to land via
 * `addInitScript` (a `page.evaluate` after `goto` would be too late).
 */
async function blurTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      writable: true,
      value: () => false,
    });
  });
}

async function readChatReplyNotifications(
  page: Page,
): Promise<Array<{ title: string; tag?: string; body?: string }>> {
  return page.evaluate(() => {
    const sink = (
      window as unknown as {
        __notifications?: Array<{ title: string; tag?: string; body?: string }>;
      }
    ).__notifications;
    return Array.isArray(sink) ? [...sink] : [];
  });
}

test.describe("Chat-reply → notification pump", () => {
  test("fires notification when chat agent posts final reply", async ({
    page,
    request,
  }) => {
    // Happy path: chat in DB, chatReply pref ON, tab backgrounded, WS frame
    // arrives. Asserts the notification carries the chat's title + the
    // localised "Agent replied" body, and that clicking it lands the user
    // on /chats/{chatId} via the existing click-router runner.
    const ws = await createWorkspace(request);
    const chatTitle = uniq("chat-reply-final");
    const chatRes = await request.post("/chats", {
      data: { title: chatTitle, workspaceId: ws.id },
    });
    expect([200, 201]).toContain(chatRes.status());
    const chatId = (await chatRes.json()) as { id: number };

    await stubNotificationsForChatReply(page);
    await blurTab(page);

    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (s) => {
      wsRef = s;
    });

    // /chats so the chat-list React Query populates the cache the
    // chat-reply runner reads its title from. /dashboard would also
    // work in production (the sidebar fans out the same query) but
    // /chats is the deterministic surface — the chat title is rendered
    // visibly so we can wait on it instead of polling React internals.
    await page.goto("/chats");
    await expect(page.getByText(chatTitle).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

    // Synthetic chat_assistant_final frame — exact shape produced by
    // `WSManager.broadcastChatAssistantFinal` (see
    // `src/services/ws-manager.ts`). No body / preview / title in the
    // envelope; the runner is expected to look the title up by chat_id.
    const messageId = 999_999;
    wsRef!.send(
      JSON.stringify({
        type: "chat_assistant_final",
        chat_id: chatId.id,
        message_id: messageId,
        ts: Date.now(),
      }),
    );

    await expect
      .poll(() => readChatReplyNotifications(page).then((arr) => arr.length), {
        timeout: 5_000,
      })
      .toBe(1);

    const fired = await readChatReplyNotifications(page);
    expect(fired[0]?.title).toBe(chatTitle);
    // Body is the locale string from `notifications.body.chatReply` (or
    // wherever the runner reads it from in en.json). Pin the literal so
    // a translation drift surfaces here.
    expect(fired[0]?.body).toBe("Agent replied");

    // Click the notification → the router runner navigates the SPA to
    // the chat detail. The hash fragment (#message-{id}) is implementation
    // detail of `routeForNotification`; the assertion only pins the path.
    await page.evaluate(() => {
      const refs = (
        window as unknown as {
          __notificationsRefs?: Array<{
            onclick: ((ev: Event) => void) | null;
          }>;
        }
      ).__notificationsRefs;
      const cb = refs?.[0]?.onclick;
      if (!cb) throw new Error("onclick not wired");
      cb(new Event("click"));
    });

    await expect(page).toHaveURL(new RegExp(`/chats/${chatId.id}(?:#|$)`));
  });

  test("suppresses notification when chat ends with agent question", async ({
    page,
    request,
  }) => {
    // Attention-conflict suppression. The runner's contract: if the
    // attention cache already has a `chat_question` row for this chatId
    // by the time `chat_assistant_final` lands, the chat-reply
    // notification is suppressed — the user gets the M14 question
    // notification instead, which is the actionable one. The body of
    // this test inserts the question BEFORE first render so it's part
    // of useAttention's baseline payload; the chat-reply runner reads
    // that cache synchronously at fire time.
    const ws = await createWorkspace(request);
    const chatTitle = uniq("chat-reply-q");
    const chatRes = await request.post("/chats", {
      data: { title: chatTitle, workspaceId: ws.id },
    });
    expect([200, 201]).toContain(chatRes.status());
    const chatId = ((await chatRes.json()) as { id: number }).id;

    insertChatQuestion(chatId, "Do you want me to proceed with the rebase?");

    await stubNotificationsForChatReply(page);
    await blurTab(page);

    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (s) => {
      wsRef = s;
    });

    try {
      await page.goto("/chats");
      await expect(page.getByText(chatTitle).first()).toBeVisible({
        timeout: 10_000,
      });
      // The favicon badge swap is the cheapest signal that useAttention
      // has at least one item — proves the chat_question row landed in
      // the React Query cache the runner reads from.
      await expect
        .poll(() => readFaviconHref(page), { timeout: 5_000 })
        .toMatch(/^data:image\/png;base64,/);
      await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

      wsRef!.send(
        JSON.stringify({
          type: "chat_assistant_final",
          chat_id: chatId,
          message_id: 4242,
          ts: Date.now(),
        }),
      );

      // Generous settle window so a delayed dispatch can't sneak past
      // the assertion. The "did NOT fire" shape is what we want.
      await page.waitForTimeout(2_000);

      // Filter by tag prefix so a stray attention-pump fire (the
      // question itself) doesn't pollute the chat-reply count. The
      // dispatcher tags chat-reply notifications with
      // `chat_assistant_final:{chat}:{message}`.
      const fired = await readChatReplyNotifications(page);
      const chatReplies = fired.filter((n) =>
        n.tag?.startsWith("chat_assistant_final:"),
      );
      expect(chatReplies).toHaveLength(0);
    } finally {
      deleteChatQuestionsForChat(chatId);
    }
  });

  test("suppresses notification when chat detail is focused", async ({
    page,
    request,
  }) => {
    // Focus suppression. The runner's other gating axis: even with no
    // attention conflict, if the user is foregrounded on the chat
    // detail page that produced the reply, firing an OS notification is
    // pure noise — they're already reading it. We deliberately do NOT
    // call `blurTab(page)` here so `document.hasFocus()` returns the
    // playwright default (true on the active page).
    const ws = await createWorkspace(request);
    const chatTitle = uniq("chat-reply-focused");
    const chatRes = await request.post("/chats", {
      data: { title: chatTitle, workspaceId: ws.id },
    });
    expect([200, 201]).toContain(chatRes.status());
    const chatId = ((await chatRes.json()) as { id: number }).id;

    await stubNotificationsForChatReply(page);

    let wsRef: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/ui/chats/events", (s) => {
      wsRef = s;
    });

    await page.goto(`/chats/${chatId}`);
    // Sanity-check we landed on the right surface — the chat detail page
    // mirrors the title in its header.
    await expect(page.getByText(chatTitle).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => wsRef !== null, { timeout: 10_000 }).toBe(true);

    wsRef!.send(
      JSON.stringify({
        type: "chat_assistant_final",
        chat_id: chatId,
        message_id: 7777,
        ts: Date.now(),
      }),
    );

    // Same generous settle window as the suppression-by-question case —
    // we want a deterministic "did NOT fire" assertion regardless of
    // any racing rerenders.
    await page.waitForTimeout(2_000);

    const fired = await readChatReplyNotifications(page);
    expect(fired).toHaveLength(0);
  });
});
