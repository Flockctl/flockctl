import { test, expect } from "@playwright/test";
import { createProject, createTask } from "./_helpers";

test("task detail page renders after task creation", async ({ page, request }) => {
  const proj = await createProject(request);
  const task = await createTask(request, proj.id, { prompt: "task-detail-check" });

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("Prompt").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("task-detail-check").first()).toBeVisible();
});

test("agent question prompt appears on WS frame and disappears on answer", async ({
  page,
  request,
}) => {
  const proj = await createProject(request);
  const task = await createTask(request, proj.id, { prompt: "ask-question-check" });

  // The page calls GET /tasks/:id/questions on mount to hydrate any pending
  // question that predates the WebSocket. Return an empty list so the hook
  // starts clean; the WS push below is the one that should surface the prompt.
  await page.route(`**/tasks/${task.id}/questions`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
  });

  const QUESTION = "Which branch should I target — main or develop?";
  const REQUEST_ID = "q-abc-123";

  // Intercept the WS the task detail page subscribes to and stand in for the
  // real backend. We hold onto the server-side route so we can push frames on
  // demand inside the test body.
  let wsRef: import("@playwright/test").WebSocketRoute | null = null;
  await page.routeWebSocket(`**/ws/ui/tasks/${task.id}/logs`, (ws) => {
    wsRef = ws;
  });

  // Intercept the answer POST so we can assert it was called with the right
  // payload without touching a real in-flight session.
  let answerPostBody: { answer?: unknown } | null = null;
  let answerPostHits = 0;
  await page.route(
    `**/tasks/${task.id}/question/${REQUEST_ID}/answer`,
    async (route) => {
      answerPostHits += 1;
      answerPostBody = route.request().postDataJSON() as typeof answerPostBody;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, taskStatus: "running" }),
      });
    },
  );

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("ask-question-check").first()).toBeVisible({
    timeout: 10_000,
  });

  // Wait for the mocked WebSocket to be claimed by the app, then push an
  // agent_question frame shaped exactly like `wsManager.broadcast(taskId, …)`
  // on the backend ({ type, payload, taskId } top-level).
  await expect.poll(() => wsRef !== null, { timeout: 5_000 }).toBe(true);
  wsRef!.send(
    JSON.stringify({
      type: "agent_question",
      taskId: task.id,
      payload: {
        task_id: String(task.id),
        chat_id: null,
        request_id: REQUEST_ID,
        question: QUESTION,
        tool_use_id: "tu-1",
        db_id: 42,
      },
    }),
  );

  const prompt = page.getByTestId("agent-question-prompt");
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("agent-question-text")).toHaveText(QUESTION);

  // Send is disabled until something is typed — mirrors the composer UX.
  const sendBtn = page.getByTestId("agent-question-send");
  await expect(sendBtn).toBeDisabled();

  const textarea = page.getByTestId("agent-question-textarea");
  await textarea.fill("target main");
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();

  // The mocked POST should have fired exactly once with the expected body.
  await expect.poll(() => answerPostHits, { timeout: 5_000 }).toBe(1);
  expect(answerPostBody?.answer).toBe("target main");

  // The mutation's onSuccess drops the cached question eagerly — the prompt
  // should disappear without needing the resolved WS frame. Simulate the
  // server-side resolved frame too, so both code paths are exercised.
  wsRef!.send(
    JSON.stringify({
      type: "agent_question_resolved",
      taskId: task.id,
      payload: {
        task_id: String(task.id),
        request_id: REQUEST_ID,
        answer: "target main",
      },
    }),
  );
  await expect(prompt).toBeHidden({ timeout: 5_000 });
});
