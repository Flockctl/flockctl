import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Replace the global WebSocket layer used indirectly through React Query
// invalidation paths. None of these tests actually need a socket — but the
// hook-tree resolves it at import time, so we stub it the same way
// `use-attention.test.tsx` (slice 02) does.
vi.mock("@/lib/ws", () => ({
  useWebSocket: () => ({ state: "open", send: vi.fn() }),
  ConnectionState: {
    CONNECTING: "connecting",
    OPEN: "open",
    CLOSING: "closing",
    CLOSED: "closed",
  },
  MessageType: {},
}));

// Must import AFTER vi.mock so the row resolves to the mocked WS module
// transitively (queryKeys / hooks pull in `@/lib/ws`).
import { AttentionRow } from "@/components/attention/attention-row";
import type { AttentionItem } from "@/lib/api";
import type { Project } from "@/lib/types";

/* ------------------------------------------------------------------------ */
/* Test infrastructure                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Build a JSON Response object the same shape the existing inbox tests use
 * (see `ui/src/__tests__/hooks/use-attention.test.tsx`). Keeps fetch mocks
 * realistic — `apiFetch` reads `res.text()` and `JSON.parse`s, so a hand-
 * rolled `{ ok: true }` shim would not exercise the real code path.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Render under a fresh QueryClient + MemoryRouter — the row uses
 * `useQueryClient()` to invalidate the inbox cache after a successful POST,
 * and `<Link>` to deep-link to the task/chat detail page. Both providers
 * are required for the row to mount without throwing.
 */
function renderRow(item: AttentionItem, projectsById?: Map<string, Project>) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AttentionRow
            item={item}
            projectsById={projectsById ?? new Map()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

const taskQuestionFixture: Extract<AttentionItem, { kind: "task_question" }> = {
  kind: "task_question",
  request_id: "req-task-1",
  task_id: "42",
  project_id: "p-1",
  question: "Which deploy target?",
  header: "Deploy",
  options: [
    { label: "staging", description: "auto-rollback on failure" },
    { label: "canary", description: "5% traffic" },
    { label: "production" },
  ],
  multi_select: false,
  created_at: "2026-04-26T12:00:00Z",
};

const chatQuestionFixture: Extract<AttentionItem, { kind: "chat_question" }> = {
  kind: "chat_question",
  request_id: "req-chat-9",
  chat_id: "777",
  project_id: "p-1",
  question: "Save and continue?",
  header: "Save",
  options: [
    { label: "yes" },
    { label: "no" },
    { label: "show diff" },
  ],
  multi_select: false,
  created_at: "2026-04-26T12:01:00Z",
};

const taskApprovalFixture: Extract<AttentionItem, { kind: "task_approval" }> = {
  kind: "task_approval",
  task_id: "10",
  project_id: "p-1",
  title: "Run migrations",
  since: "2026-04-26T11:00:00Z",
};

const chatApprovalFixture: Extract<AttentionItem, { kind: "chat_approval" }> = {
  kind: "chat_approval",
  chat_id: "11",
  project_id: "p-1",
  title: "Confirm deploy",
  since: "2026-04-26T11:01:00Z",
};

const taskPermissionFixture: Extract<AttentionItem, { kind: "task_permission" }> = {
  kind: "task_permission",
  task_id: "12",
  project_id: "p-1",
  request_id: "perm-1",
  tool: "Bash",
  since: "2026-04-26T11:02:00Z",
};

const chatPermissionFixture: Extract<AttentionItem, { kind: "chat_permission" }> = {
  kind: "chat_permission",
  chat_id: "13",
  project_id: "p-1",
  request_id: "perm-2",
  tool: "Edit",
  since: "2026-04-26T11:03:00Z",
};

const projectsById = new Map<string, Project>([
  ["p-1", { id: "p-1", name: "demo-project" } as unknown as Project],
]);

/* ------------------------------------------------------------------------ */
/* Helpers for asserting fetch dispatch                                      */
/* ------------------------------------------------------------------------ */

/**
 * Assert that a fetch mock was called with the given path + body.
 * `apiFetch` prefixes the local daemon URL — we only assert the
 * trailing path so the test isn't tied to the dev port constant.
 */
function expectFetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  expectedPathSuffix: string,
  expectedBody: Record<string, unknown>,
) {
  // Find a matching call (other ambient hooks may issue parallel fetches).
  const match = fetchMock.mock.calls.find((call) =>
    typeof call[0] === "string" && (call[0] as string).endsWith(expectedPathSuffix),
  );
  expect(match, `expected a fetch to a path ending with ${expectedPathSuffix}`).toBeTruthy();
  const init = match![1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(typeof init?.body).toBe("string");
  // `apiFetch` normalises body keys snake → camel, but `answer` is single-word
  // so it survives unchanged. Decoding from JSON is safer than string compare
  // because key order is implementation-defined.
  const parsed = JSON.parse(init!.body as string);
  expect(parsed).toEqual(expectedBody);
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

beforeEach(() => {
  // Default fetch — every test that exercises a POST overrides this with a
  // mock that asserts on the call. The default mock just yields an empty 200
  // so any unexpected GET (e.g. a transient cache prefetch) does not blow up.
  (globalThis as any).fetch = vi.fn().mockResolvedValue(jsonResponse({}));
});

describe("AttentionRow — task/chat question dispatch", () => {
  it("renders_task_question_with_picker: 3 radios + project chip + task title", () => {
    renderRow(taskQuestionFixture, projectsById);

    // The picker comes from AgentQuestionPrompt (slice 02) — three radios
    // because `multi_select` is false, no checkboxes.
    const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3);
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

    // Each option label is rendered.
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("canary")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();

    // The agent's question text is shown.
    expect(screen.getByText("Which deploy target?")).toBeInTheDocument();

    // Row chrome — the project name from the projectsById lookup, plus a
    // task identifier somewhere on the row.
    expect(screen.getByText("demo-project")).toBeInTheDocument();
    expect(screen.getByText(/Task #42|task-42|task_42/i)).toBeInTheDocument();
  });

  it("renders_chat_question_with_picker: 3 radios + project chip + chat title", () => {
    renderRow(chatQuestionFixture, projectsById);

    const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3);

    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
    expect(screen.getByText("show diff")).toBeInTheDocument();

    expect(screen.getByText("Save and continue?")).toBeInTheDocument();
    expect(screen.getByText("demo-project")).toBeInTheDocument();
    expect(screen.getByText(/Chat #777|chat-777|chat_777/i)).toBeInTheDocument();
  });

  it("dispatches_to_task_endpoint_for_task_question: POST /tasks/<id>/question/<rid>/answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;

    const user = userEvent.setup();
    renderRow(taskQuestionFixture, projectsById);

    // Pick the first option ("staging").
    await user.click(screen.getByTestId("agent-question-option-0"));
    await user.click(screen.getByTestId("agent-question-send"));

    await waitFor(() => {
      expectFetchCall(
        fetchMock,
        "/tasks/42/question/req-task-1/answer",
        { answer: "staging" },
      );
    });
  });

  it("dispatches_to_chat_endpoint_for_chat_question: POST /chats/<id>/question/<rid>/answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;

    const user = userEvent.setup();
    renderRow(chatQuestionFixture, projectsById);

    await user.click(screen.getByTestId("agent-question-option-0")); // "yes"
    await user.click(screen.getByTestId("agent-question-send"));

    await waitFor(() => {
      expectFetchCall(
        fetchMock,
        "/chats/777/question/req-chat-9/answer",
        { answer: "yes" },
      );
    });
  });

  it("existing_kinds_render_identically: task/chat approval + permission rows still render their chrome", () => {
    // Each existing kind should mount without ever invoking the question
    // component code paths. We don't deep-snapshot the DOM (that would
    // ossify Tailwind classes); we lock in the chrome-level pieces a user
    // would actually see and that a regression in the new question rows
    // could plausibly break: kind badge, action buttons, deep-link target.

    function chromeOf(item: AttentionItem) {
      const { container, unmount } = renderRow(item, projectsById);
      const buttons = within(container)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim() ?? "");
      const badge = container.querySelector('[class*="bg-secondary"], .badge');
      const link = container.querySelector("a");
      const summary = {
        buttons,
        kindBadgeText: badge?.textContent?.trim() ?? null,
        deepLink: link?.getAttribute("href") ?? null,
        // No question prompt — would be a regression if it appeared here.
        hasQuestionPrompt: container.querySelector(
          '[data-testid="agent-question-prompt"]',
        ) !== null,
      };
      unmount();
      return summary;
    }

    expect(chromeOf(taskApprovalFixture)).toMatchObject({
      buttons: ["Approve", "Reject"],
      hasQuestionPrompt: false,
      deepLink: "/tasks/10",
    });
    expect(chromeOf(chatApprovalFixture)).toMatchObject({
      buttons: ["Approve", "Reject"],
      hasQuestionPrompt: false,
      deepLink: "/chats/11",
    });
    expect(chromeOf(taskPermissionFixture)).toMatchObject({
      buttons: ["Allow", "Deny"],
      hasQuestionPrompt: false,
      deepLink: "/tasks/12",
    });
    expect(chromeOf(chatPermissionFixture)).toMatchObject({
      buttons: ["Allow", "Deny"],
      hasQuestionPrompt: false,
      deepLink: "/chats/13",
    });
  });

  it("failed_POST_re_enables_Send_and_shows_error: 500 keeps the row mounted, error visible, button re-enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    (globalThis as any).fetch = fetchMock;

    const user = userEvent.setup();
    renderRow(taskQuestionFixture, projectsById);

    await user.click(screen.getByTestId("agent-question-option-1")); // "canary"
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    await user.click(send);

    // Wait for the failure path: error rendered (role=alert from
    // AgentQuestionPrompt's <p role="alert"> branch) and Send re-enabled.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // The error text should surface the server-provided message.
    expect(screen.getByRole("alert").textContent).toMatch(/boom/i);

    // Row is still in the document — failed POST must not dismiss it.
    expect(screen.getByText("Which deploy target?")).toBeInTheDocument();

    // Send returned to enabled (a selection is still active, so the disabled
    // gate is purely the in-flight `pending` flag clearing).
    expect(send.disabled).toBe(false);
  });

  // The current implementation in slice 02 (AgentQuestionPrompt + the
  // approve/reject row family in `attention-row.tsx`) deliberately does NOT
  // optimistically dismiss: every sibling row sets `setHidden(true)` only
  // *after* a successful POST resolves. Question rows are expected to follow
  // the same pattern (the comment block at the top of attention-row.tsx
  // documents this choice as "list-scale, no optimistic UI"). Per the task
  // brief, the optimistic-rollback case is therefore omitted with this
  // comment in lieu of a placeholder test that would always pass.
});
