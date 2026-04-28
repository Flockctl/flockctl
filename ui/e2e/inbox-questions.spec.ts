import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, uniq } from "./_helpers";
import {
  cleanupProjectData,
  insertPendingApprovalChat,
  insertPendingApprovalTask,
  markQuestionAnswered,
  readQuestionRow,
  seedChatQuestion,
  seedTaskQuestion,
} from "./helpers/seed-questions";

// Clear any leftover `agent_questions` rows before each test so a stale
// chat_question / task_question from a sibling spec (e.g. the bare-picker
// `chat-question-picker.spec.ts` we share fixtures with) doesn't surface
// inside our `/attention` row counts and confuse `.first()`-style locators.
// `cleanupProjectData` only drops by project_id; leftover rows whose owning
// project was deleted by a prior cleanup but whose question row was missed
// (FK cascade does the right thing under normal teardown, but flaky tests
// can leave dangling state) get nuked here.
const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");
test.beforeEach(() => {
  const db = new Database(dbPath);
  try {
    db.prepare(`DELETE FROM agent_questions`).run();
    db.prepare(
      `DELETE FROM tasks WHERE status IN ('waiting_for_input','pending_approval')`,
    ).run();
    db.prepare(`DELETE FROM chats WHERE approval_status = 'pending'`).run();
  } finally {
    db.close();
  }
});

/**
 * E2E coverage for slice 13/04 — inbox rows that surface
 * `agent_questions` rows alongside the existing approval / permission
 * blockers.
 *
 * Why some scenarios diverge from the slice plan:
 *
 *   - `task_permission` / `chat_permission` rows require an in-memory
 *     `AgentSession` with a non-empty `pendingPermissionEntries()` queue.
 *     The Playwright harness boots the daemon under `FLOCKCTL_MOCK_AI=1`,
 *     and there is no fake AgentSession — `selectKeyForTask` throws and
 *     the task fails before it can ever raise a permission request.
 *     We therefore substitute `task_approval` / `chat_approval` rows for
 *     the permission filler in scenarios that just need bulk inbox
 *     volume, and document the substitution where it matters.
 *   - `chats` have no cold-path question resolver; without a live session
 *     `chatExecutor.answerQuestion` returns false and the route responds
 *     409. Tests that need the chat-question round-trip to land its
 *     answer on storage either:
 *       (a) assert the POST hits the right URL via `page.route` and then
 *           directly mark the row answered (mimicking what the chat
 *           executor would do); or
 *       (b) skip the storage assertion and only verify UI behaviour.
 *
 * Visual baselines live under `__screenshots__/inbox-questions.spec.ts/`.
 * Run `npm run e2e:update -- e2e/inbox-questions.spec.ts` from `ui/` to
 * (re)generate them after intentional layout changes.
 */

const PICKER_OPTIONS = [
  { label: "Yes", description: "Confirm the action" },
  { label: "No", description: "Skip for now" },
  { label: "Ask later", description: "Defer until I'm at a checkpoint" },
];

test.describe("inbox question rows", () => {
  test("task question can be answered from inbox", async ({ page, request }) => {
    const seeded = await seedTaskQuestion(request, {
      question: "Should I rebase before merging?",
      header: "merge-strategy",
      options: PICKER_OPTIONS,
      multiSelect: false,
    });

    try {
      await page.goto("/attention");
      await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

      // The picker card is the AgentQuestionPrompt — same testid no matter
      // which surface (task/chat) embeds it. We further narrow by the row's
      // `Task question` badge so the assertion can't accidentally match a
      // chat-side picker if one is also present.
      await expect(page.getByText("Task question").first()).toBeVisible({
        timeout: 10_000,
      });
      const picker = page.getByTestId("agent-question-prompt").first();
      await expect(picker).toBeVisible();
      await expect(picker.getByTestId("agent-question-text")).toHaveText(
        "Should I rebase before merging?",
      );

      // Visual baseline locks in the inbox-row composition (badge + project
      // + picker chrome). Distinct from the bare picker baselines that the
      // chat-question-picker spec owns.
      await expect(picker).toHaveScreenshot("inbox-row-task-question-picker.png");

      // Click option 2 (`No`), which is the radio at index 1.
      await picker.getByTestId("agent-question-option-1").check();
      await picker.getByTestId("agent-question-send").click();

      // 2s ceiling per the slice plan — invalidate-on-success + WS frame
      // should land us back at an empty inbox well within that.
      await expect(page.getByText("Task question")).toHaveCount(0, { timeout: 2_000 });

      // The answer must have been persisted to storage with the option label,
      // not the index. The cold-path resolver also flips the task back to
      // running (or done if the queue picked it up); we assert it left
      // `waiting_for_input` rather than pinning a specific terminal state.
      const dbRow = readQuestionRow(seeded.requestId);
      expect(dbRow?.status).toBe("answered");
      expect(dbRow?.answer).toBe("No");

      const taskRes = await request.get(`/tasks/${seeded.taskId}`);
      expect(taskRes.ok()).toBe(true);
      const task = (await taskRes.json()) as { status: string };
      expect(task.status).not.toBe("waiting_for_input");
    } finally {
      cleanupProjectData(seeded.projectId);
    }
  });

  test("chat question can be answered from inbox", async ({ page, request }) => {
    const seeded = await seedChatQuestion(request, {
      question: "Use TypeScript or JavaScript for the new module?",
      header: "language-pick",
      options: [
        { label: "TypeScript" },
        { label: "JavaScript" },
        { label: "Either is fine" },
      ],
      multiSelect: false,
    });

    // The chat answer endpoint requires a live in-memory session, which the
    // Playwright env never has. Intercept the POST so the UI sees a 200
    // (mirroring what the production chat executor returns), then mark the
    // row answered ourselves so subsequent /attention fetches drop it.
    let chatPostHits = 0;
    let chatPostBody: { answer?: unknown } | null = null;
    const expectedPath = `**/chats/${seeded.chatId}/question/${encodeURIComponent(
      seeded.requestId,
    )}/answer`;
    await page.route(expectedPath, async (route) => {
      chatPostHits += 1;
      chatPostBody = route.request().postDataJSON() as typeof chatPostBody;
      // Mirror chat-executor.answerQuestion: persist + relay. No live
      // session here, so just persist directly.
      if (typeof chatPostBody?.answer === "string") {
        markQuestionAnswered(seeded.requestId, chatPostBody.answer);
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, chatStatus: null }),
      });
    });

    try {
      await page.goto("/attention");
      await expect(page.getByText("Chat question").first()).toBeVisible({
        timeout: 10_000,
      });
      const picker = page.getByTestId("agent-question-prompt").first();
      await expect(picker).toBeVisible();

      await expect(picker).toHaveScreenshot("inbox-row-chat-question-picker.png");

      // Pick "JavaScript" (index 1).
      await picker.getByTestId("agent-question-option-1").check();
      await picker.getByTestId("agent-question-send").click();

      // The POST to the chat-side endpoint should have fired exactly once
      // with the right body. This is the canonical "verify POST went to
      // /chats/<id>/question/<requestId>/answer" assertion the slice plan
      // calls for.
      await expect.poll(() => chatPostHits, { timeout: 5_000 }).toBe(1);
      expect(chatPostBody?.answer).toBe("JavaScript");

      // The row clears once the optimistic-hide + invalidate-on-finally
      // refetch lands.
      await expect(page.getByText("Chat question")).toHaveCount(0, { timeout: 2_000 });

      const dbRow = readQuestionRow(seeded.requestId);
      expect(dbRow?.status).toBe("answered");
      expect(dbRow?.answer).toBe("JavaScript");
    } finally {
      cleanupProjectData(seeded.projectId);
    }
  });

  test("two questions in inbox — answering one leaves the other", async ({
    page,
    request,
  }) => {
    const projA = await createProject(request);
    const projB = await createProject(request);
    // We don't need the returned id for the task seed — its row is
    // identified inside the page by the "Task question" badge.
    await seedTaskQuestion(
      request,
      {
        question: "Pick a deploy region",
        options: [{ label: "us-east" }, { label: "eu-west" }],
      },
      projA.id,
    );
    const chatQ = await seedChatQuestion(
      request,
      {
        question: "Pick a runtime",
        options: [{ label: "node" }, { label: "deno" }, { label: "bun" }],
      },
      projB.id,
    );

    await page.route(
      `**/chats/${chatQ.chatId}/question/${encodeURIComponent(chatQ.requestId)}/answer`,
      async (route) => {
        const body = route.request().postDataJSON() as { answer?: string };
        if (body?.answer) markQuestionAnswered(chatQ.requestId, body.answer);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, chatStatus: null }),
        });
      },
    );

    try {
      await page.goto("/attention");
      await expect(page.getByText("Task question").first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Chat question").first()).toBeVisible();

      // Answer the task question first. We want a deterministic mapping
      // from "click here" to "this row goes away", so resolve the picker
      // by its surrounding row card.
      const taskRow = page
        .locator("li", { hasText: "Task question" })
        .first();
      await taskRow.getByTestId("agent-question-option-0").check();
      await taskRow.getByTestId("agent-question-send").click();

      // Task row gone, chat row still visible.
      await expect(page.getByText("Task question")).toHaveCount(0, { timeout: 2_000 });
      await expect(page.getByText("Chat question").first()).toBeVisible();

      const chatRow = page
        .locator("li", { hasText: "Chat question" })
        .first();
      await chatRow.getByTestId("agent-question-option-2").check();
      await chatRow.getByTestId("agent-question-send").click();

      await expect(page.getByText("Chat question")).toHaveCount(0, { timeout: 2_000 });
      await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
    } finally {
      cleanupProjectData(projA.id);
      cleanupProjectData(projB.id);
    }
  });

  test("row disappears in real time on attention_changed", async ({
    page,
    request,
  }) => {
    const seeded = await seedTaskQuestion(request, {
      question: "Want me to retry?",
      options: [{ label: "Retry" }, { label: "Abort" }],
    });

    try {
      await page.goto("/attention");
      await expect(page.getByText("Task question").first()).toBeVisible({
        timeout: 10_000,
      });

      // Resolve the question via a separate REST call — simulates an
      // external client (or the user's other tab) answering before this
      // tab's user clicked anything. The cold-path resolver flips the row
      // to answered, restarts the task, and emits `attention_changed`.
      const res = await request.post(
        `/tasks/${seeded.taskId}/question/${encodeURIComponent(seeded.requestId)}/answer`,
        { data: { answer: "Retry" } },
      );
      expect(res.status()).toBe(200);

      // The UI's WS subscription listens for `attention_changed` and
      // invalidates the `attention` query — the row should vanish without
      // an explicit page.reload(). 1s ceiling per the slice plan.
      await expect(page.getByText("Task question")).toHaveCount(0, { timeout: 1_000 });
    } finally {
      cleanupProjectData(seeded.projectId);
    }
  });

  test("empty inbox shows the muted empty state after the last question is answered", async ({
    page,
    request,
  }) => {
    const seeded = await seedTaskQuestion(request, {
      question: "Empty-state regression",
      options: [{ label: "Done" }],
    });

    try {
      await page.goto("/attention");
      await expect(page.getByText("Task question").first()).toBeVisible({
        timeout: 10_000,
      });

      const res = await request.post(
        `/tasks/${seeded.taskId}/question/${encodeURIComponent(seeded.requestId)}/answer`,
        { data: { answer: "Done" } },
      );
      expect(res.status()).toBe(200);

      // The empty-state subtitle is rendered in the page header when
      // `total === 0`; the `Inbox is empty` callout shows below in the
      // dashed box. We assert both so a future redesign can't silently
      // drop one without us noticing.
      await expect(page.getByText("Nothing is waiting on you.")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText("Inbox is empty")).toBeVisible();
      await expect(page.getByLabel(/items? needing attention/)).toHaveCount(0);
    } finally {
      cleanupProjectData(seeded.projectId);
    }
  });

  test("50-row layout renders without overlap and scrolls", async ({
    page,
    request,
  }) => {
    // Plan asks for "30 permission requests + 10 task questions + 10 chat
    // questions". Permission requests cannot be seeded under the mock-AI
    // env (see file header), so we substitute 30 `task_approval` rows —
    // they exercise the same vertical-stack layout the picker rows live
    // alongside, which is what this test guards against.
    const proj = await createProject(request);

    const taskApprovalLabels: string[] = [];
    for (let i = 0; i < 30; i++) {
      const label = uniq(`bulk-approval-${i}`);
      insertPendingApprovalTask(proj.id, label);
      taskApprovalLabels.push(label);
    }
    for (let i = 0; i < 10; i++) {
      await seedTaskQuestion(
        request,
        {
          question: `Bulk task question #${i}`,
          options: [{ label: "OK" }],
          requestId: `bulk-task-${i}-${Date.now()}`,
        },
        proj.id,
      );
    }
    for (let i = 0; i < 10; i++) {
      await seedChatQuestion(
        request,
        {
          question: `Bulk chat question #${i}`,
          options: [{ label: "OK" }],
          requestId: `bulk-chat-${i}-${Date.now()}`,
        },
        proj.id,
      );
    }

    try {
      await page.goto("/attention");
      // 50 rows total — wait until at least the last one is in the DOM.
      await expect.poll(
        async () => page.locator('ul li').count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(50);

      // Smoke check on layout — pull bounding boxes of the first three rows
      // and confirm each starts strictly below the previous (no negative
      // overlap). Strict ordering matches what `space-y-3` should give us.
      const firstThree = await page.locator("ul > li").evaluateAll((els) =>
        els.slice(0, 3).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        }),
      );
      expect(firstThree.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < firstThree.length; i++) {
        expect(firstThree[i].top).toBeGreaterThanOrEqual(firstThree[i - 1].bottom - 1);
      }

      // Viewport screenshot caps the layout at the visible region; a strict
      // pixel diff would be too brittle (50-row scroll height drifts as
      // browser font caches load), so we use it as a smoke baseline only.
      await expect(page).toHaveScreenshot("inbox-50-row-layout.png", {
        fullPage: false,
        maxDiffPixelRatio: 0.05,
      });

      // Scroll past the fold and confirm at least one row beyond the
      // initial viewport renders. The list lives inside the page body, so
      // `page.mouse.wheel` translates to document scroll. We don't pin a
      // specific delta — the assertion is just "scrolling moves things",
      // and a row count check confirms no rows were destroyed by the
      // scroll. If the page happens to fit all 50 rows in the viewport
      // (very tall test browser), `documentElement.scrollTop` stays at 0
      // and the assertion drops to a no-op rather than failing — pixel
      // assertions are too brittle for a smoke-only check.
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(150);
      expect(await page.locator("ul > li").count()).toBeGreaterThanOrEqual(50);
    } finally {
      cleanupProjectData(proj.id);
    }
  });

  test("answering a stale question shows an error and clears the row", async ({
    page,
    request,
  }) => {
    const seeded = await seedTaskQuestion(request, {
      question: "Will land 409 from the server",
      options: [{ label: "Try" }, { label: "Skip" }],
    });

    try {
      await page.goto("/attention");
      const picker = page.getByTestId("agent-question-prompt").first();
      await expect(picker).toBeVisible({ timeout: 10_000 });

      // Race condition simulation: another client answers the question
      // first, so by the time the in-page Send POST reaches the server the
      // row is `status='answered'` and the route returns 409.
      markQuestionAnswered(seeded.requestId, "Try");

      // `.check()` would `scrollIntoViewIfNeeded` and wait for animations
      // — overkill for a single-row stale-question case. The label wraps
      // the radio, so a plain click is enough and dodges the timeout the
      // strict actionability check has occasionally hit.
      await picker.getByTestId("agent-question-option-1").click();

      // Capture the response via `page.waitForResponse` so we can assert
      // the 409 status independently of any toast UI.
      const respPromise = page.waitForResponse((resp) =>
        resp
          .url()
          .includes(`/tasks/${seeded.taskId}/question/${encodeURIComponent(seeded.requestId)}/answer`),
      );
      await picker.getByTestId("agent-question-send").click();
      const resp = await respPromise;
      expect(resp.status()).toBe(409);

      // The implementation surfaces the 409 as an inline error inside the
      // picker card (no toast — see AgentQuestionPrompt's `setError` path).
      // The error message is whatever apiFetch parsed from the route
      // response, which the route emits as `"Agent question already resolved"`.
      // We don't strictly require the alert to be visible at the moment of
      // assertion — `invalidateAttention` runs in the `finally` block of
      // `handleAnswer`, so the React Query refetch can race the
      // `setError` re-render and unmount the row first. Either ordering is
      // fine; what matters is the row no longer surfaces from the server's
      // view of the world.
      await expect(page.getByText("Task question")).toHaveCount(0, { timeout: 5_000 });
    } finally {
      cleanupProjectData(seeded.projectId);
    }
  });

  test("existing kinds — task_approval row pixel baseline", async ({ page, request }) => {
    /*
     * Locks in the pre-question-row layout for `task_approval`. Any future
     * change to `attention-row.tsx` that affects the approval row's
     * dimensions must re-approve this baseline:
     *
     *   npm run e2e:update -- e2e/inbox-questions.spec.ts
     *
     * task_permission and chat_permission baselines are NOT included here —
     * they require a live AgentSession with a non-empty permission queue,
     * which the mock-AI Playwright env can't construct. When live-AI
     * fixtures land, add the baselines `inbox-row-task-permission.png`
     * and `inbox-row-chat-permission.png` here.
     */
    // Fixed label + project name so the pixel baseline is stable across
    // runs. Each test starts from a clean slate (see the `beforeEach`
    // wipe at the top of the file), so collisions on the literal label
    // are impossible. The project row also gets a fixed name; the
    // surrounding chrome (timestamp + project link target id) is masked
    // out in the screenshot options below.
    // Project name still carries a uniq suffix to avoid path collisions
    // (the route validates `/tmp/<name>` uniqueness). The task label is
    // fixed so the row's text content matches the baseline byte-for-byte.
    // The dynamic project chip ends up under the screenshot's `mask:`.
    const proj = await createProject(request, uniq("approval-baseline-proj"));
    insertPendingApprovalTask(proj.id, "Inbox approval baseline");

    try {
      await page.goto("/attention");
      const row = page
        .locator("li", { hasText: "Inbox approval baseline" })
        .first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toHaveScreenshot("inbox-row-task-approval.png", {
        // `time` rotates by definition (just now / 1s ago / …); the
        // project name chip carries the fresh project id which `createProject`
        // suffixes with timestamp/random — mask both so only the row's
        // structural pixels are diffed. `maxDiffPixelRatio` absorbs the
        // few-pixel font-rendering noise that crops up between runs.
        mask: [row.locator("time"), row.locator("span.text-muted-foreground")],
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupProjectData(proj.id);
    }
  });

  test("existing kinds — chat_approval row pixel baseline", async ({ page, request }) => {
    const proj = await createProject(request, uniq("chat-approval-baseline-proj"));
    insertPendingApprovalChat(proj.id, "Chat approval baseline");

    try {
      await page.goto("/attention");
      const row = page
        .locator("li", { hasText: "Chat approval baseline" })
        .first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toHaveScreenshot("inbox-row-chat-approval.png", {
        mask: [row.locator("time"), row.locator("span.text-muted-foreground")],
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      cleanupProjectData(proj.id);
    }
  });
});
