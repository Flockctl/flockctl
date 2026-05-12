import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * Slice 24-ui-redesign-working-surfaces/04-attention, T00 — pin the merge
 * contract for `useAttentionInbox`.
 *
 * Pins (mirrors `negative_tests` declared in the task front-matter):
 *
 *   - 3 mocked sources merge correctly with stable sort (priority first,
 *     newest-first within priority).
 *   - 1 source fails, others still produce data + `partialErrors[]` set.
 *   - `isLoading` is the OR of the three source loading flags.
 *   - Empty input produces `items: []` and `partialErrors: []`.
 *
 * The whole point of the hook is to stitch three independent sources
 * together — so we replace each source with a deterministic factory via
 * `vi.mock` and assert the merged output end-to-end. No HTTP, no QueryClient,
 * no setup ceremony.
 */

const useAgentQuestionsAllSpy = vi.fn();
const useMissionProposalsAllSpy = vi.fn();
const useFailedTasks24hSpy = vi.fn();

vi.mock("@/lib/hooks/attention-sources", () => ({
  useAgentQuestionsAll: () => useAgentQuestionsAllSpy(),
  useMissionProposalsAll: () => useMissionProposalsAllSpy(),
  useFailedTasks24h: () => useFailedTasks24hSpy(),
}));

// Must import AFTER vi.mock so the hook resolves to the stubbed sources.
import { useAttentionInbox } from "@/lib/hooks/use-attention-inbox";

beforeEach(() => {
  useAgentQuestionsAllSpy.mockReset();
  useMissionProposalsAllSpy.mockReset();
  useFailedTasks24hSpy.mockReset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { data, isLoading: false, error: null };
}
function loading<T>(data: T) {
  return { data, isLoading: true, error: null };
}
function failing<T>(data: T, error: unknown) {
  return { data, isLoading: false, error };
}

// Realistic fixture rows. Created times are ISO strings for question rows
// (matches the wire shape on `/attention`) and epoch seconds for mission
// proposals (matches `MissionProposal.created_at`); failed-task rows ship
// ISO strings (matches `Task.created_at`).
const NOW = Date.parse("2026-05-07T12:00:00.000Z");

const TASK_QUESTION_NEWEST = {
  kind: "task_question" as const,
  request_id: "req-q-1",
  task_id: "100",
  project_id: "1",
  question: "Which file should I edit?",
  multi_select: false,
  created_at: new Date(NOW - 60_000).toISOString(),
};
const CHAT_QUESTION_OLDER = {
  kind: "chat_question" as const,
  request_id: "req-q-2",
  chat_id: "200",
  project_id: "2",
  question: "Confirm rename?",
  multi_select: false,
  created_at: new Date(NOW - 5 * 60_000).toISOString(),
};

const MISSION_PROPOSAL_MID = {
  id: "evt-1",
  mission_id: "mission-abc",
  title: "Add a regression test for slice 24/04",
  context: "Mission supervisor proposal",
  created_at: Math.floor((NOW - 3 * 60_000) / 1000),
};

const FAILED_TASK_OLDEST = {
  id: "300",
  title: "Run e2e against local daemon",
  project_id: "1",
  created_at: new Date(NOW - 10 * 60_000).toISOString(),
};
const FAILED_TASK_NEWER = {
  id: "301",
  title: "Lint the UI",
  project_id: "1",
  created_at: new Date(NOW - 2 * 60_000).toISOString(),
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe("useAttentionInbox — merge logic", () => {
  it("3 mocked sources merge with stable priority+time sort", () => {
    useAgentQuestionsAllSpy.mockReturnValue(
      ok([TASK_QUESTION_NEWEST, CHAT_QUESTION_OLDER]),
    );
    useMissionProposalsAllSpy.mockReturnValue(ok([MISSION_PROPOSAL_MID]));
    useFailedTasks24hSpy.mockReturnValue(
      ok([FAILED_TASK_OLDEST, FAILED_TASK_NEWER]),
    );

    const { result } = renderHook(() => useAttentionInbox());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.partialErrors).toEqual([]);

    // Critical (failed tasks) first, then normal (questions + proposals).
    // Within each bucket: newest-first.
    const sources = result.current.items.map((it) => it.source);
    expect(sources).toEqual([
      // critical bucket (failed tasks): newer first
      "failed_task", // id 301 (newer)
      "failed_task", // id 300 (older)
      // normal bucket: question (1m) > proposal (3m) > question (5m)
      "agent_question",
      "mission_proposal",
      "agent_question",
    ]);

    // Spot-check the actual rows.
    expect(result.current.items[0]).toMatchObject({
      source: "failed_task",
      priority: "critical",
      key: "failed_task:301",
      href: "/tasks/301",
    });
    expect(result.current.items[2]).toMatchObject({
      source: "agent_question",
      priority: "normal",
      key: "agent_question:100:req-q-1",
      title: "Which file should I edit?",
      href: "/tasks/100",
    });
    expect(result.current.items[3]).toMatchObject({
      source: "mission_proposal",
      priority: "normal",
      key: "mission_proposal:mission-abc:evt-1",
      href: "/missions/mission-abc",
    });
  });

  it("preserves source insertion order on equal priority+time (stable sort)", () => {
    // Both rows have the same priority (normal) AND the same created_at —
    // ES2019 stable sort guarantees the agent question lands before the
    // mission proposal (matches the merge order: q, then p, then t).
    const sameTimeIso = new Date(NOW).toISOString();
    const sameTimeSec = Math.floor(NOW / 1000);

    useAgentQuestionsAllSpy.mockReturnValue(
      ok([{ ...TASK_QUESTION_NEWEST, created_at: sameTimeIso }]),
    );
    useMissionProposalsAllSpy.mockReturnValue(
      ok([{ ...MISSION_PROPOSAL_MID, created_at: sameTimeSec }]),
    );
    useFailedTasks24hSpy.mockReturnValue(ok([]));

    const { result } = renderHook(() => useAttentionInbox());

    expect(result.current.items.map((it) => it.source)).toEqual([
      "agent_question",
      "mission_proposal",
    ]);
  });

  it("isolates a failing source: others render, error lands in partialErrors", () => {
    const boom = new Error("agent questions endpoint timed out");
    useAgentQuestionsAllSpy.mockReturnValue(failing([], boom));
    useMissionProposalsAllSpy.mockReturnValue(ok([MISSION_PROPOSAL_MID]));
    useFailedTasks24hSpy.mockReturnValue(ok([FAILED_TASK_NEWER]));

    const { result } = renderHook(() => useAttentionInbox());

    // The other two sources still produced rows.
    expect(result.current.items.map((it) => it.source)).toEqual([
      "failed_task",
      "mission_proposal",
    ]);
    // The failing source's error is surfaced (single entry).
    expect(result.current.partialErrors).toEqual([boom]);
    // A failing source must NOT mark the whole inbox as loading.
    expect(result.current.isLoading).toBe(false);
  });

  it("ignores errored source data even if the source hook returned non-empty rows", () => {
    // Defense-in-depth: even if a buggy source returns rows alongside an
    // error, the merge drops them so the UI never paints stale data above
    // an error banner.
    const boom = new Error("stale cache");
    useAgentQuestionsAllSpy.mockReturnValue(
      failing([TASK_QUESTION_NEWEST], boom),
    );
    useMissionProposalsAllSpy.mockReturnValue(ok([]));
    useFailedTasks24hSpy.mockReturnValue(ok([]));

    const { result } = renderHook(() => useAttentionInbox());
    expect(result.current.items).toEqual([]);
    expect(result.current.partialErrors).toEqual([boom]);
  });

  it("isLoading is the OR of the three source loading flags", () => {
    useAgentQuestionsAllSpy.mockReturnValue(ok([]));
    useMissionProposalsAllSpy.mockReturnValue(loading([]));
    useFailedTasks24hSpy.mockReturnValue(ok([]));

    const { result } = renderHook(() => useAttentionInbox());
    expect(result.current.isLoading).toBe(true);
  });

  it("empty input → items:[] and partialErrors:[]", () => {
    useAgentQuestionsAllSpy.mockReturnValue(ok([]));
    useMissionProposalsAllSpy.mockReturnValue(ok([]));
    useFailedTasks24hSpy.mockReturnValue(ok([]));

    const { result } = renderHook(() => useAttentionInbox());
    expect(result.current.items).toEqual([]);
    expect(result.current.partialErrors).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("collects errors from multiple failing sources in source order", () => {
    const eQ = new Error("q failed");
    const eT = new Error("t failed");
    useAgentQuestionsAllSpy.mockReturnValue(failing([], eQ));
    useMissionProposalsAllSpy.mockReturnValue(ok([]));
    useFailedTasks24hSpy.mockReturnValue(failing([], eT));

    const { result } = renderHook(() => useAttentionInbox());
    expect(result.current.partialErrors).toEqual([eQ, eT]);
    expect(result.current.items).toEqual([]);
  });

  it("each emitted item has a unique stable key", () => {
    useAgentQuestionsAllSpy.mockReturnValue(
      ok([TASK_QUESTION_NEWEST, CHAT_QUESTION_OLDER]),
    );
    useMissionProposalsAllSpy.mockReturnValue(ok([MISSION_PROPOSAL_MID]));
    useFailedTasks24hSpy.mockReturnValue(
      ok([FAILED_TASK_OLDEST, FAILED_TASK_NEWER]),
    );

    const { result } = renderHook(() => useAttentionInbox());
    const keys = result.current.items.map((it) => it.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
