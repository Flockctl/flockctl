import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Radix primitives need these shims in jsdom ----------------------------
beforeAll(() => {
  const proto = window.HTMLElement.prototype as any;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
});

// --- Hooks mock (shared across every test) --------------------------------
const streamMocks = {
  startStream: vi.fn(),
  cancelStream: vi.fn(),
  enqueueMessage: vi.fn(),
  removeFromQueue: vi.fn(),
  clearQueue: vi.fn(),
  clearChat: vi.fn(),
  isStreaming: false,
  liveBlocks: [] as any[],
  queuedMessages: [] as any[],
  error: null as string | null,
};
const eventStreamMocks = {
  permissionRequests: [] as any[],
  dismissPermissionRequest: vi.fn(),
  sessionRunning: false,
};
const agentQuestionMocks = { question: null as any };
const chatTodosMocks = { data: null as any };
let chatDetail: any = null;
let chatLoading = false;
// Mutable mock holders — read by the `useMeta` / `useProjectAllowedKeys`
// mocks on every render so tests can simulate the async allow-list fetch
// resolving AFTER the chat first renders (the race the auto-select guard
// in ChatConversation now defends against).
const metaMock: { data: any } = {
  data: {
    keys: [{ id: 1, name: "key-a", is_active: true }],
    models: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
    defaults: { model: "claude-sonnet-4-6", key_id: 1 },
  },
};
const projectAllowedKeysMock: { data: any } = {
  data: { allowedKeyIds: null, source: "none" },
};
// Workspace-only chats use this in place of the project allow-list. The
// chat-conversation guard only fires the workspace fetch when the chat
// has a workspaceId AND no projectId, so the default "no restriction"
// payload is a safe baseline for every test that pins a project.
const workspaceAllowedKeysMock: { data: any } = {
  data: { allowedKeyIds: null, source: "none" },
};

// Captures the most recent `useChatStream` options so tests can pin down
// what ChatConversation passed in (chatId, serverBusy). Reset in
// beforeEach. Lets us assert on cooperation with the runner without
// rendering React hooks ourselves.
const streamHookOpts: { last: { chatId?: string | null; serverBusy?: boolean } | null } =
  { last: null };

vi.mock("@/lib/hooks", () => ({
  useChat: () => ({ data: chatDetail, isLoading: chatLoading }),
  useChatStream: (opts?: { chatId?: string | null; serverBusy?: boolean }) => {
    streamHookOpts.last = opts ?? {};
    return streamMocks;
  },
  useChatEventStream: () => eventStreamMocks,
  useAgentQuestions: () => agentQuestionMocks,
  useAnswerAgentQuestion: () => ({ mutateAsync: vi.fn() }),
  useChatTodos: () => chatTodosMocks,
  // New — `<ChatConversation>` renders a "Changes" card at the bottom powered
  // by useChatDiff; tests don't exercise the card so a flat null response is
  // enough to keep the component from throwing on the hook call.
  useChatDiff: () => ({ data: null }),
  useUpdateChat: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProject: () => ({ mutateAsync: vi.fn() }),
  useUpdateWorkspace: () => ({ mutateAsync: vi.fn() }),
  useProjectConfig: () => ({ data: null }),
  // Resolves the project's effective AI-key allow-list (workspace → project
  // inheritance). A null allow-list means "no restriction", which matches
  // the legacy behavior these tests were written against. Individual tests
  // can mutate `projectAllowedKeysMock.data` to simulate loading / fetched
  // states.
  useProjectAllowedKeys: () => projectAllowedKeysMock,
  useWorkspaceAllowedKeys: () => workspaceAllowedKeysMock,
  useMeta: () => metaMock,
}));

vi.mock("@/lib/api", () => ({
  respondToChatPermission: vi.fn(),
  uploadChatAttachment: vi.fn(),
  getApiBaseUrl: () => "",
}));

// Stub the TodoHistoryDrawer / SaveAsIncidentDialog — their internals hit
// other hooks we don't care about here.
vi.mock("@/components/TodoHistoryDrawer", () => ({
  TodoHistoryDrawer: () => null,
}));
vi.mock("@/components/save-as-incident-dialog", () => ({
  SaveAsIncidentDialog: () => null,
}));

import { ChatConversation } from "@/components/chat-conversation";

beforeEach(() => {
  streamMocks.isStreaming = false;
  streamMocks.liveBlocks = [];
  streamMocks.queuedMessages = [];
  streamMocks.error = null;
  streamMocks.startStream.mockReset();
  streamMocks.cancelStream.mockReset();
  streamMocks.enqueueMessage.mockReset();
  streamMocks.removeFromQueue.mockReset();
  streamMocks.clearQueue.mockReset();
  streamMocks.clearChat.mockReset();
  streamHookOpts.last = null;
  eventStreamMocks.permissionRequests = [];
  eventStreamMocks.sessionRunning = false;
  agentQuestionMocks.question = null;
  chatTodosMocks.data = null;
  chatDetail = null;
  chatLoading = false;
  // Reset the async-swappable mocks back to the "no restriction" baseline.
  metaMock.data = {
    keys: [{ id: 1, name: "key-a", is_active: true }],
    models: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
    defaults: { model: "claude-sonnet-4-6", key_id: 1 },
  };
  projectAllowedKeysMock.data = { allowedKeyIds: null, source: "none" };
  workspaceAllowedKeysMock.data = { allowedKeyIds: null, source: "none" };
});

function renderConversation(
  props: Partial<React.ComponentProps<typeof ChatConversation>> = {}
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ChatConversation chatId="c-1" {...props} />
    </QueryClientProvider>
  );
}

describe("ChatConversation", () => {
  it("renders the default empty state when there are no messages", () => {
    chatDetail = { id: "c-1", messages: [] };
    renderConversation();
    expect(screen.getByText("Start a conversation")).toBeTruthy();
  });

  it("renders a custom emptyState when provided", () => {
    chatDetail = { id: "c-1", messages: [] };
    renderConversation({ emptyState: <p>Nothing here yet</p> });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.queryByText("Start a conversation")).toBeNull();
  });

  it("renders existing messages from chat detail", () => {
    chatDetail = {
      id: "c-1",
      messages: [
        { id: "1", role: "user", content: "hello" },
        { id: "2", role: "assistant", content: "world" },
      ],
    };
    renderConversation();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("shows the 'Response was not received' retry bubble when last message is user-side and no stream running — after the grace period", () => {
    chatDetail = {
      id: "c-1",
      messages: [{ id: "1", role: "user", content: "hi" }],
      is_running: false,
    };
    vi.useFakeTimers();
    try {
      renderConversation();
      // Grace period: the pill is debounced by ~3.5s so every normal
      // send → setup → first-byte window doesn't flash it. Before the
      // timer elapses the bubble must NOT be on screen.
      expect(screen.queryByText("Response was not received")).toBeNull();
      // Advance past the debounce threshold; the setTimeout in
      // <ChatConversation> fires and flips the render flag. Wrapped in
      // `act` so React flushes the resulting state update synchronously
      // instead of deferring the commit past the assertion.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText("Response was not received")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the agent-question prompt when one is active", () => {
    chatDetail = { id: "c-1", messages: [] };
    agentQuestionMocks.question = {
      question: "which branch?",
      requestId: "req-9",
    };
    renderConversation();
    expect(screen.getByTestId("agent-question-prompt")).toBeTruthy();
    expect(screen.getByTestId("agent-question-text").textContent).toBe(
      "which branch?"
    );
  });

  it("shows the multi-select toggle by default and hides it when disabled", () => {
    chatDetail = { id: "c-1", messages: [] };
    const { rerender } = renderConversation();
    expect(screen.getByTestId("chat-select-mode-toggle")).toBeTruthy();

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false, gcTime: 0 },
              mutations: { retry: false },
            },
          })
        }
      >
        <ChatConversation chatId="c-1" enableMultiSelect={false} />
      </QueryClientProvider>
    );
    expect(screen.queryByTestId("chat-select-mode-toggle")).toBeNull();
  });

  it("enters select mode, checks a message, and shows the action bar", async () => {
    const user = userEvent.setup();
    chatDetail = {
      id: "c-1",
      messages: [
        { id: "10", role: "user", content: "hi there" },
        { id: "11", role: "assistant", content: "hello" },
      ],
    };
    renderConversation();
    await user.click(screen.getByTestId("chat-select-mode-toggle"));
    const checkboxes = screen.getAllByTestId("chat-message-checkbox");
    expect(checkboxes).toHaveLength(2);
    await user.click(checkboxes[0]!);
    expect(screen.getByTestId("chat-action-bar")).toBeTruthy();
    expect(screen.getByText("1 message selected")).toBeTruthy();
  });

  it("renders todo progress bar when chatTodos has a non-empty count", () => {
    chatDetail = { id: "c-1", messages: [] };
    chatTodosMocks.data = {
      counts: { total: 3, completed: 1, in_progress: 1, pending: 1 },
    };
    renderConversation();
    expect(screen.getByTestId("todo-progress")).toBeTruthy();
    expect(screen.getByTestId("todo-history-button")).toBeTruthy();
  });

  it("uses provided headerSlot in place of default header", () => {
    chatDetail = { id: "c-1", messages: [] };
    renderConversation({ headerSlot: <h1>Custom header</h1> });
    expect(screen.getByRole("heading", { name: "Custom header" })).toBeTruthy();
  });

  it("forwards placeholder to the composer", () => {
    chatDetail = { id: "c-1", messages: [] };
    renderConversation({ placeholder: "Ask about this slice..." });
    expect(
      screen.getByTestId("chat-composer-textarea").getAttribute("placeholder")
    ).toBe("Ask about this slice...");
  });

  it("disables the composer when composerDisabled is passed", () => {
    chatDetail = { id: "c-1", messages: [] };
    renderConversation({ composerDisabled: true });
    const textarea = screen.getByTestId(
      "chat-composer-textarea"
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("renders stream error banner when streamError is set", () => {
    chatDetail = { id: "c-1", messages: [] };
    streamMocks.error = "stream-broken";
    renderConversation();
    expect(screen.getByText(/stream-broken/)).toBeTruthy();
  });

  it("shows the Stop (cancel) button after a reload while the server reports the chat is still running", async () => {
    // Post-reload scenario: local `isStreaming` is false (this hook instance
    // never opened the SSE stream), but the backend session is still alive
    // — surfaced via WS `sessionRunning=true`. The composer must render the
    // Stop button so the user can abort the in-flight turn, and clicking it
    // must call `cancelStream(chatId)` with the chatId passed through.
    //
    // Send stays rendered alongside Stop now that follow-up prompts go into
    // the queue (see "queues a send ..." test below) — pre-queue behavior
    // hid Send while streaming, but hiding it would make a recovered
    // mid-turn session un-queueable after reload.
    const user = userEvent.setup();
    chatDetail = { id: "c-1", messages: [], is_running: true };
    streamMocks.isStreaming = false;
    eventStreamMocks.sessionRunning = true;
    renderConversation();
    const cancelBtn = screen.getByTestId("chat-composer-cancel");
    expect(cancelBtn).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-send")).not.toBeNull();
    await user.click(cancelBtn);
    expect(streamMocks.cancelStream).toHaveBeenCalledWith("c-1");
  });

  it("queues a send instead of starting a second stream when a turn is already running", async () => {
    // While the server session is still running, hitting Send must NOT start
    // a second concurrent `startStream` — it must go on the queue so the
    // drain effect picks it up after the current turn ends. Matches
    // Claude Code: follow-up prompts line up, they don't race.
    const user = userEvent.setup();
    chatDetail = { id: "c-1", messages: [] };
    streamMocks.isStreaming = true;
    eventStreamMocks.sessionRunning = false;
    renderConversation();
    const textarea = screen.getByTestId("chat-composer-textarea");
    await user.type(textarea, "next one");
    await user.click(screen.getByTestId("chat-composer-send"));
    expect(streamMocks.startStream).not.toHaveBeenCalled();
    expect(streamMocks.enqueueMessage).toHaveBeenCalledTimes(1);
    const [chatId, data] = streamMocks.enqueueMessage.mock.calls[0]!;
    expect(chatId).toBe("c-1");
    expect(data.content).toBe("next one");
  });

  it("renders the queued-messages bar and removes an entry on ✕ click", async () => {
    // Bar appears only when queuedMessages is non-empty. Each entry shows
    // the user's prompt and an ✕ that removes it via `removeFromQueue`.
    const user = userEvent.setup();
    chatDetail = { id: "c-1", messages: [] };
    streamMocks.queuedMessages = [
      { id: "queued-1", chatId: "c-1", data: { content: "first" } },
      { id: "queued-2", chatId: "c-1", data: { content: "second" } },
    ];
    renderConversation();
    const bar = screen.getByTestId("chat-queued-bar");
    // M25 redesign — header reads "<N> queued · runs after current turn"
    // and each row carries its position badge (#1, #2). The pre-M25
    // "Queued (N)" copy is gone; the count is embedded in a sentence.
    expect(bar.textContent).toContain("2 queued");
    expect(bar.textContent).toContain("runs after current turn");
    const items = screen.getAllByTestId("chat-queued-item");
    expect(items).toHaveLength(2);
    const removes = screen.getAllByTestId("chat-queued-remove");
    await user.click(removes[0]!);
    expect(streamMocks.removeFromQueue).toHaveBeenCalledWith("queued-1");
  });

  it("REGRESSION: passes chatId to useChatStream so the queue is keyed correctly (runner cooperation)", () => {
    chatDetail = { id: "c-1", messages: [] };
    chatLoading = false;
    eventStreamMocks.sessionRunning = false;
    renderConversation();
    expect(streamHookOpts.last?.chatId).toBe("c-1");
  });

  it("REGRESSION: serverBusy=true while chatDetail is still loading (prevents drain race on first mount)", () => {
    // Reproducer: on first chat mount, `useChat` is still fetching so
    // `chatDetail` is undefined and `is_running` is unknown. Without
    // gating on `chatLoading` here, `serverBusy` would resolve to
    // `false` and the drain effect could fire optimistically — opening
    // a parallel turn next to whatever the daemon was actually doing.
    chatDetail = null;
    chatLoading = true;
    eventStreamMocks.sessionRunning = null as unknown as boolean; // WS not yet connected
    renderConversation();
    expect(streamHookOpts.last?.serverBusy).toBe(true);
  });

  it("REGRESSION: serverBusy=true when sessionRunning is true even if chatDetail.is_running is false", () => {
    // The OR semantics matter: a stale `is_running=false` from cache
    // must not override a live `sessionRunning=true` WS frame.
    chatDetail = { id: "c-1", is_running: false, messages: [] };
    chatLoading = false;
    eventStreamMocks.sessionRunning = true;
    renderConversation();
    expect(streamHookOpts.last?.serverBusy).toBe(true);
  });

  it("REGRESSION: serverBusy=true when chatDetail.is_running is true even if sessionRunning is false", () => {
    chatDetail = { id: "c-1", is_running: true, messages: [] };
    chatLoading = false;
    eventStreamMocks.sessionRunning = false;
    renderConversation();
    expect(streamHookOpts.last?.serverBusy).toBe(true);
  });

  it("REGRESSION: serverBusy=false only when ALL signals say idle", () => {
    chatDetail = { id: "c-1", is_running: false, messages: [] };
    chatLoading = false;
    eventStreamMocks.sessionRunning = false;
    renderConversation();
    expect(streamHookOpts.last?.serverBusy).toBe(false);
  });

  it("'Clear all' button on the queued-messages bar calls clearQueue (BUG #4 / #5)", async () => {
    // Regression: before the fix, the queue could only be drained one entry
    // at a time via the per-chip ✕. Pressing Stop on the composer aborted
    // the in-flight turn but left the queue intact, so users had no way to
    // bail out of a long line of follow-ups they no longer wanted. The new
    // "Clear all" button on the queue bar wires up the previously unused
    // `clearQueue` helper.
    const user = userEvent.setup();
    chatDetail = { id: "c-1", messages: [] };
    streamMocks.queuedMessages = [
      { id: "queued-1", chatId: "c-1", data: { content: "first" } },
      { id: "queued-2", chatId: "c-1", data: { content: "second" } },
      { id: "queued-3", chatId: "c-1", data: { content: "third" } },
    ];
    renderConversation();
    // M25 redesign — header now reads "3 queued · runs after current turn"
    // (with the count baked into the sentence), not the pre-M25
    // "Queued (3)" prefix.
    expect(screen.getByTestId("chat-queued-bar").textContent).toContain(
      "3 queued",
    );
    const clearBtn = screen.getByTestId("chat-queued-clear");
    expect(clearBtn).toBeTruthy();
    await user.click(clearBtn);
    expect(streamMocks.clearQueue).toHaveBeenCalledTimes(1);
    // Per-chip removeFromQueue must NOT be called by the bulk action — it
    // would interleave optimistic state with the bulk wipe.
    expect(streamMocks.removeFromQueue).not.toHaveBeenCalled();
  });

  it("hides liveBlocks once the turn has ended to prevent a duplicate of the persisted assistant message", () => {
    // Regression: when a turn finishes, the `session_ended` WS refetch pulls
    // the final assistant message into chatDetail.messages — at the same
    // time liveBlocks still hold the closed streaming blocks from the same
    // turn. Rendering both rendered the final response twice. Gating the
    // liveBlocks render on `isStreaming || serverRunning` drops them once
    // the turn is done on both fronts.
    chatDetail = {
      id: "c-1",
      messages: [
        {
          id: "m-1",
          role: "assistant",
          content: "final",
          chat_id: "c-1",
          created_at: "2026-04-22T00:00:00Z",
        },
      ],
    };
    streamMocks.isStreaming = false;
    streamMocks.liveBlocks = [
      { id: "live-1", kind: "text", content: "final", streaming: false },
    ];
    eventStreamMocks.sessionRunning = false;
    renderConversation();
    // One rendering of "final" from `messages.map`, zero from the live
    // transcript (gated off). Before the fix this query returned 2.
    expect(screen.getAllByText("final")).toHaveLength(1);
  });

  it("renders liveBlocks inline in order (thinking → tool_call → tool_result → text)", () => {
    chatDetail = { id: "c-1", messages: [] };
    streamMocks.isStreaming = true;
    streamMocks.liveBlocks = [
      { id: "live-1", kind: "thinking", content: "reasoning", streaming: false },
      {
        id: "live-2",
        kind: "tool_call",
        name: "Grep",
        input: { pattern: "foo" },
        summary: "pattern=foo",
        createdAt: "2026-05-09T10:16:00.000Z",
      },
      {
        id: "live-3",
        kind: "tool_result",
        name: "Grep",
        output: "match-1",
        summary: "1 match",
        createdAt: "2026-05-09T10:16:01.000Z",
      },
      { id: "live-4", kind: "text", content: "answer", streaming: true },
    ];
    renderConversation();
    expect(screen.getAllByTestId("thinking-block").length).toBeGreaterThan(0);
    const toolRows = screen.getAllByTestId("stored-tool-message");
    expect(toolRows).toHaveLength(2);
    expect(screen.getByText("answer")).toBeTruthy();
  });

  it("applies the agent-glow class to the latest assistant turn when is_streaming=true", () => {
    chatDetail = {
      id: "c-1",
      messages: [
        { id: "1", role: "user", content: "hello" },
        { id: "2", role: "assistant", content: "world", is_streaming: true },
      ],
    };
    renderConversation();
    const container = screen.getByTestId("agent-glow-turn");
    expect(container.className).toMatch(/\bagent-glow\b/);
  });

  it("does NOT add agent-glow on non-streaming turns", () => {
    chatDetail = {
      id: "c-1",
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "done", is_streaming: false },
      ],
    };
    renderConversation();
    expect(screen.queryByTestId("agent-glow-turn")).toBeNull();
    // The persisted assistant row still renders, just without the glow.
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("only flags the LATEST assistant message as streaming, never older rows", () => {
    // Defensive: a stale `is_streaming=true` on an earlier row must not glow
    // — only the row at messages.length-1 ever gets the class. Without the
    // index gate, any historical row left over from a previous turn would
    // pulse forever.
    chatDetail = {
      id: "c-1",
      messages: [
        { id: "1", role: "assistant", content: "old", is_streaming: true },
        { id: "2", role: "user", content: "follow-up" },
      ],
    };
    renderConversation();
    expect(screen.queryByTestId("agent-glow-turn")).toBeNull();
  });

  // Regression: a project whose allow-list only permits the "Work" key used
  // to default to the user's global "Personal" key, because the auto-select
  // effect fired before `useProjectAllowedKeys` resolved. The effect now
  // waits for the allow-list fetch to complete before picking a default.
  it("auto-selects a project-permitted key instead of the user's global default when the allow-list resolves after first render", async () => {
    const user = userEvent.setup();
    // Two keys — Personal (id=1, the user's global default) and Work (id=2).
    metaMock.data = {
      keys: [
        { id: 1, name: "Personal", is_active: true },
        { id: 2, name: "Work", is_active: true },
      ],
      models: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
      defaults: { model: "claude-sonnet-4-6", key_id: 1 },
    };
    // Project-scoped chat, but the allow-list fetch hasn't resolved yet.
    chatDetail = { id: "c-1", project_id: 42, messages: [] };
    projectAllowedKeysMock.data = undefined;
    const { rerender } = renderConversation();
    // The allow-list now resolves — only Work (id=2) is permitted.
    projectAllowedKeysMock.data = {
      allowedKeyIds: [2],
      source: "project",
    };
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false, gcTime: 0 },
              mutations: { retry: false },
            },
          })
        }
      >
        <ChatConversation chatId="c-1" />
      </QueryClientProvider>
    );
    // Send a message — the keyId forwarded to startStream proves which key
    // the auto-selector picked. It MUST be Work (2), not the global default
    // Personal (1), because Personal isn't in the project's allow-list.
    const textarea = screen.getByTestId("chat-composer-textarea");
    await user.type(textarea, "hi");
    await user.click(screen.getByTestId("chat-composer-send"));
    expect(streamMocks.startStream).toHaveBeenCalledTimes(1);
    const [, body] = streamMocks.startStream.mock.calls[0]!;
    expect(body.keyId).toBe(2);
  });
});
