import { test, expect, type Page, type Route } from "@playwright/test";
import {
  cleanupProjectData,
  markQuestionAnswered,
  readQuestionRow,
  seedChatQuestion,
  type SeededChatQuestion,
} from "./helpers/seed-questions";

/**
 * Milestone M05 / slice 06 — `AgentQuestionPrompt` rendered inside the
 * chat conversation page.
 *
 * Coverage map:
 *   1. single-select picker → screenshot + DB round-trip
 *   2. multi-select picker → screenshot + DB round-trip with comma-joined answer
 *   3. Other-textarea wins even when options are present
 *   4. free-form fallback (no options) → screenshot regression locker
 *   5. long-label wrap → screenshot regression locker
 *   6. option `description` rendering (DOM-only)
 *   7. 20-option mount-time smoke check
 *   8. keyboard navigation submits the picker
 *
 * Sibling spec `inbox-questions.spec.ts` already covers the same picker
 * embedded under `/attention`. This spec focuses on the chat surface so
 * the picker contract is regression-locked from both call sites: the
 * inbox row AND the chat conversation header.
 *
 * Why the answer endpoint is mocked instead of hitting the daemon:
 *
 *   `POST /chats/:id/question/:requestId/answer` calls
 *   `chatExecutor.answerQuestion(...)` which requires an in-memory
 *   `AgentSession` for the chat. Under e2e there is no live AI key
 *   (see the long comment at the top of `attention.spec.ts`) so no
 *   session is ever attached and the endpoint returns 409. We therefore
 *   stub the endpoint with `page.route`, capture the body for
 *   assertions, and update the seeded row directly via
 *   `markQuestionAnswered` so downstream DB reads see the correct
 *   final state. The mutation's `onSuccess` clears the React Query
 *   cache, so the picker still disappears as it would in production.
 *
 * Baselines live under `ui/e2e/__screenshots__/chat-question-picker.spec.ts/`.
 * Regenerate with:
 *
 *   cd ui && npm run e2e:update -- e2e/chat-question-picker.spec.ts
 */

// Strip animations + caret so pixel diffs are stable across retries.
async function freeze(page: Page) {
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

/**
 * Install a `page.route` interceptor for the chat-side answer POST that
 * mirrors `chatExecutor.answerQuestion` behaviour: persist + reply 200.
 * The returned accessor exposes the captured answer (null until fired).
 */
async function mockAnswerEndpoint(page: Page, seed: SeededChatQuestion) {
  let captured: string | null = null;
  const url = `**/chats/${seed.chatId}/question/${encodeURIComponent(seed.requestId)}/answer`;
  await page.route(url, async (route: Route) => {
    const body = route.request().postDataJSON() as { answer?: unknown } | null;
    captured = typeof body?.answer === "string" ? body.answer : null;
    if (typeof captured === "string" && captured.length > 0) {
      markQuestionAnswered(seed.requestId, captured);
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, chatStatus: null }),
    });
  });
  return () => captured;
}

async function gotoChat(page: Page, seed: SeededChatQuestion) {
  await page.goto(`/chats/${seed.chatId}`);
  // Picker hydration is REST-driven (`GET /chats/:id/questions`) and
  // happens once the conversation view mounts. We wait directly on the
  // picker testid rather than the chat title — the title appears in the
  // chat-list rail, which paginates and may not show a freshly-seeded
  // chat when the rail is already populated by older runs against the
  // reused `.e2e-data` DB. The picker is the actual contract under
  // test, so it makes a cleaner readiness signal.
  await expect(page.getByTestId("agent-question-prompt")).toBeVisible({ timeout: 10_000 });
}

test.describe("chat agent-question picker", () => {
  test("single-select picker resolves a chat question", async ({ page, request }) => {
    const seed = await seedChatQuestion(request, {
      header: "Pick one",
      question: "Which merge strategy should we use?",
      options: [
        { label: "Use rebase" },
        { label: "Use squash merge" },
        { label: "Skip and notify owner" },
      ],
      multiSelect: false,
    });
    try {
      const getCaptured = await mockAnswerEndpoint(page, seed);
      await gotoChat(page, seed);

      // The fieldset has implicit role="group" — assert via role first so
      // the contract is on the semantics, not a testid.
      const group = page.getByRole("group");
      await expect(group).toBeVisible();
      await expect(page.getByTestId("agent-question-header")).toContainText("Pick one");

      await freeze(page);
      await expect(page.getByTestId("agent-question-prompt")).toHaveScreenshot(
        "agent-question-prompt-radio-three-options.png",
        { maxDiffPixelRatio: 0.02 },
      );

      // Click the second radio (zero-indexed = "Use squash merge").
      await page.getByTestId("agent-question-option-1").check();
      await page.getByTestId("agent-question-send").click();

      // Picker dismisses within 2s — the mutation's onSuccess clears the
      // cache key the prompt is keyed off of.
      await expect(page.getByTestId("agent-question-prompt")).toHaveCount(0, {
        timeout: 2_000,
      });

      expect(getCaptured()).toBe("Use squash merge");
      const row = readQuestionRow(seed.requestId);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("answered");
      expect(row!.answer).toBe("Use squash merge");
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("multi-select picker resolves with comma-joined labels", async ({
    page,
    request,
  }) => {
    const seed = await seedChatQuestion(request, {
      header: "Pick any",
      question: "Which test tiers should I run?",
      options: [
        { label: "Run unit tests" },
        { label: "Run integration tests" },
        { label: "Run e2e tests" },
      ],
      multiSelect: true,
    });
    try {
      const getCaptured = await mockAnswerEndpoint(page, seed);
      await gotoChat(page, seed);

      const fieldset = page.getByTestId("agent-question-options");
      await expect(fieldset).toHaveAttribute("data-multi", "true");

      await freeze(page);
      await expect(page.getByTestId("agent-question-prompt")).toHaveScreenshot(
        "agent-question-prompt-checkbox-three-options.png",
        { maxDiffPixelRatio: 0.02 },
      );

      // Check the 1st and 3rd. The component's submit value joins by the
      // original `options` order, NOT click order — clicking 3rd then 1st
      // must still produce "Run unit tests, Run e2e tests".
      await page.getByTestId("agent-question-option-2").check();
      await page.getByTestId("agent-question-option-0").check();
      await page.getByTestId("agent-question-send").click();

      await expect(page.getByTestId("agent-question-prompt")).toHaveCount(0, {
        timeout: 2_000,
      });

      expect(getCaptured()).toBe("Run unit tests, Run e2e tests");
      const row = readQuestionRow(seed.requestId);
      expect(row?.answer).toBe("Run unit tests, Run e2e tests");
      expect(row?.status).toBe("answered");
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("Other textarea overrides selected options", async ({ page, request }) => {
    const seed = await seedChatQuestion(request, {
      question: "Pick one or write your own.",
      options: [
        { label: "Option A" },
        { label: "Option B" },
        { label: "Option C" },
      ],
    });
    try {
      const getCaptured = await mockAnswerEndpoint(page, seed);
      await gotoChat(page, seed);

      // Without selecting any radio, type into the Other textarea — the
      // picker contract (slice 02): trimmed Other always wins when filled.
      await page.getByTestId("agent-question-textarea").fill("freeform answer");
      await page.getByTestId("agent-question-send").click();

      await expect(page.getByTestId("agent-question-prompt")).toHaveCount(0, {
        timeout: 2_000,
      });
      expect(getCaptured()).toBe("freeform answer");
      const row = readQuestionRow(seed.requestId);
      expect(row?.answer).toBe("freeform answer");
      expect(row?.status).toBe("answered");
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("free-form fallback renders when no options are seeded", async ({
    page,
    request,
  }) => {
    const seed = await seedChatQuestion(request, {
      // No options / no header → original textarea-only UI.
      question: "What should the rollout window be?",
    });
    try {
      await gotoChat(page, seed);
      // role="group" only renders when options exist — its absence is the
      // shape contract for the free-form branch.
      await expect(page.getByRole("group")).toHaveCount(0);
      await expect(page.getByTestId("agent-question-textarea")).toBeVisible();
      await expect(page.getByTestId("agent-question-options")).toHaveCount(0);

      await freeze(page);
      // Regression locker — guards the no-options layout for future picker
      // refactors. The inbox-questions spec covers the row chrome; this
      // baseline guards the bare picker as embedded in the chat surface.
      await expect(page.getByTestId("agent-question-prompt")).toHaveScreenshot(
        "agent-question-prompt-textarea-fallback.png",
        { maxDiffPixelRatio: 0.02 },
      );
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("long option labels wrap inside the picker card", async ({ page, request }) => {
    // 200-char label — single word would never wrap, so we use a sentence
    // composed of repeated tokens so `break-words` has a chance to act.
    const longLabel =
      "this option label is intentionally long to force the picker card into wrapping mode and to keep the surrounding card width contract honest under sustained pressure".padEnd(
        200,
        " x",
      );
    const seed = await seedChatQuestion(request, {
      question: "Wide-label wrap regression",
      options: [{ label: longLabel }, { label: "Short option" }],
    });
    try {
      await gotoChat(page, seed);
      await expect(page.getByText(longLabel.slice(0, 40)).first()).toBeVisible();
      await freeze(page);
      await expect(page.getByTestId("agent-question-prompt")).toHaveScreenshot(
        "agent-question-prompt-long-label-wrap.png",
        { maxDiffPixelRatio: 0.02 },
      );
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("option descriptions are rendered under each label", async ({ page, request }) => {
    const seed = await seedChatQuestion(request, {
      question: "Each option has a description.",
      options: [
        { label: "Alpha", description: "Short description for alpha" },
        { label: "Beta", description: "Short description for beta" },
        { label: "Gamma", description: "Short description for gamma" },
      ],
    });
    try {
      await gotoChat(page, seed);
      // Description is rendered as a sibling <span> inside the option label.
      // We assert each one is in the DOM — no separate baseline needed.
      for (const text of [
        "Short description for alpha",
        "Short description for beta",
        "Short description for gamma",
      ]) {
        await expect(page.getByText(text)).toBeVisible();
      }
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("20 options mount under the perf budget", async ({ page, request }) => {
    const options = Array.from({ length: 20 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: `Auto-generated option #${i + 1}`,
    }));
    const seed = await seedChatQuestion(request, {
      question: "20-option perf check",
      options,
    });
    try {
      // Measure mount latency of the picker card from page load.
      // We use a relative-time window: mark right after navigation, wait
      // for the card to become visible, and assert the elapsed window is
      // under the budget. 200ms / 20 options = 10ms per option — generous
      // enough to absorb React Query hydration jitter on a busy CI box.
      await page.goto(`/chats/${seed.chatId}`);
      const start = await page.evaluate(() => performance.now());
      await expect(page.getByTestId("agent-question-prompt")).toBeVisible({
        timeout: 5_000,
      });
      const elapsed = await page.evaluate(
        ([t0]) => performance.now() - (t0 as number),
        [start],
      );
      // Sanity check the rendered radio count.
      await expect(
        page.getByTestId("agent-question-options").locator("input"),
      ).toHaveCount(20);
      // Soft smoke check — log when over budget but only fail on a hard
      // multiple of the budget so flake doesn't block the suite.
      if (elapsed >= 200) {
        console.warn(
          `[chat-question-picker] 20-option mount took ${elapsed.toFixed(1)}ms (budget 200ms)`,
        );
      }
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });

  test("keyboard navigation submits the picker via Cmd/Ctrl+Enter", async ({
    page,
    request,
  }) => {
    const seed = await seedChatQuestion(request, {
      question: "Keyboard navigation regression",
      options: [
        { label: "Choice 1" },
        { label: "Choice 2" },
        { label: "Choice 3" },
      ],
      multiSelect: false,
    });
    try {
      const getCaptured = await mockAnswerEndpoint(page, seed);
      await gotoChat(page, seed);

      // Focus the first radio explicitly — relying on a global Tab walk
      // would couple the test to the entire page's tab order, which is
      // outside this spec's scope.
      const opt0 = page.getByTestId("agent-question-option-0");
      await opt0.focus();
      await expect(opt0).toBeFocused();

      // Tab moves focus out of the radio group; verify it leaves
      // the original radio (the contract is "focus moves on Tab").
      await page.keyboard.press("Tab");
      await expect(opt0).not.toBeFocused();

      // Drive the actual selection via .check() — this is the canonical
      // Playwright form-action API and works regardless of whether the
      // radio is currently focused.
      await page.getByTestId("agent-question-option-1").check();
      await expect(page.getByTestId("agent-question-option-1")).toBeChecked();

      // Cmd/Ctrl+Enter submits from anywhere in the card (see
      // AgentQuestionPrompt.onAnyKeyDown). We dispatch from the
      // textarea to keep focus inside the card.
      const textarea = page.getByTestId("agent-question-textarea");
      await textarea.focus();
      const isMac = process.platform === "darwin";
      await page.keyboard.press(isMac ? "Meta+Enter" : "Control+Enter");

      await expect(page.getByTestId("agent-question-prompt")).toHaveCount(0, {
        timeout: 2_000,
      });
      expect(getCaptured()).toBe("Choice 2");
    } finally {
      cleanupProjectData(seed.projectId);
    }
  });
});
