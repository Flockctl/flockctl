/**
 * Attention-inbox source hooks.
 *
 * `useAttentionInbox()` (see `./use-attention-inbox.ts`) merges three live
 * lists into one priority-sorted feed. Each source lives here so tests can
 * `vi.mock("@/lib/hooks/attention-sources", …)` and inject deterministic
 * fixtures without touching the merge module's import graph.
 *
 * Each hook returns the standard `{ data, isLoading, error }` triple. `data`
 * is always a stable shape (never `undefined`) to keep the merge function
 * branch-free; `error` is `null` while healthy and surfaces unchanged so the
 * merge can collect it into `partialErrors[]`.
 *
 * Why three modules of inputs collapse into ONE here (not one file each):
 *   - The aggregator is a single consumer; splitting per source would only
 *     add import boilerplate to the test file (three vi.mock calls instead
 *     of one) for no isolation gain.
 *   - The names mirror the slice spec literally so reviewers can grep
 *     `useAgentQuestionsAll` / `useMissionProposalsAll` / `useFailedTasks24h`
 *     and find the wiring in one place.
 */

import { useMemo } from "react";
import { useAttention } from "./attention";
import { useTasks } from "./tasks";
import type { AttentionItem } from "../api/attention";
import type { Task } from "../types";
import { TaskStatus } from "../types/task";

// ─── Source: agent questions ───────────────────────────────────────────────
//
// Derives from the existing `/attention` server-side aggregator: every
// `task_question` / `chat_question` row in that response is exactly the
// "agent waiting on a human" surface this source represents. Filtering
// client-side is correct — the UI already pays for `/attention` once and we
// do not want to issue a second request just to slice the same payload.
//
// The per-entity `useAgentQuestions({kind, id})` in `./agents.ts` is a
// DIFFERENT hook (one task / one chat). We deliberately use a distinct
// name (`useAgentQuestionsAll`) here to avoid shadowing it.

export type AgentQuestionRow = Extract<
  AttentionItem,
  { kind: "task_question" | "chat_question" }
>;

export interface AgentQuestionsAllResult {
  data: AgentQuestionRow[];
  isLoading: boolean;
  error: unknown;
}

/**
 * All currently-open agent questions (across every task + chat the user can
 * see). Backed by the same `/attention` cache that powers `useAttention()`,
 * filtered to question kinds.
 */
export function useAgentQuestionsAll(): AgentQuestionsAllResult {
  const { items, isLoading, error } = useAttention();
  const data = useMemo<AgentQuestionRow[]>(
    () =>
      items.filter(
        (it): it is AgentQuestionRow =>
          it.kind === "task_question" || it.kind === "chat_question",
      ),
    [items],
  );
  return { data, isLoading, error };
}

// ─── Source: mission proposals (cross-mission) ─────────────────────────────
//
// No server-side aggregator endpoint exists today — `useMissionProposals`
// (see `./missions.ts`) lists proposals for a SINGLE mission. Surfacing
// every pending proposal in the inbox would require either (a) a new
// `GET /missions/proposals?status=pending` endpoint, or (b) fanning out
// `useMissions(projectId)` × `useMissionProposals(id)` once per active
// mission and concatenating client-side.
//
// Both options are follow-up work flagged in the audit findings on the
// parent slice. For now this hook returns an empty list with `isLoading:
// false` so the merge produces zero rows from the proposals source — the
// rest of the pipeline (sort, partialErrors, isLoading composition) is
// fully wired and tested independently of this gap.

export interface MissionProposalRow {
  id: string;
  mission_id: string;
  title: string;
  context: string | null;
  created_at: number;
}

export interface MissionProposalsAllResult {
  data: MissionProposalRow[];
  isLoading: boolean;
  error: unknown;
}

export function useMissionProposalsAll(): MissionProposalsAllResult {
  // Stable empty array reference — re-creating on every render would force
  // `useMemo` consumers downstream to recompute even when nothing changed.
  return { data: EMPTY_PROPOSALS, isLoading: false, error: null };
}

// Stable across renders. Cast through `readonly` is fine because the
// consumers never mutate `data` — they iterate via `.map`/`.filter`.
const EMPTY_PROPOSALS: MissionProposalRow[] = [];

// ─── Source: tasks that failed within the last 24h ─────────────────────────
//
// Derived from the existing `useTasks(offset, limit, filters)` query. The
// `TaskFilters` shape currently accepts a single `status` value (no union),
// so this hook only covers `failed` today; surfacing `timed_out` rows the
// same way is a TODO and would require either a server-side `status_in`
// filter or a second parallel query.
//
// `created_after` is computed at hook-mount and re-used until the cache
// gets invalidated — small drift (a row landing right at the 24h boundary)
// is acceptable for an inbox view; we do NOT want a `useEffect`-driven
// re-issue every minute pulling fresh data into the same query key.

export interface FailedTaskRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
}

export interface FailedTasks24hResult {
  data: FailedTaskRow[];
  isLoading: boolean;
  error: unknown;
}

export function useFailedTasks24h(): FailedTasks24hResult {
  // Compute the cutoff once per render; React Query keys on the value, so a
  // stable cutoff means a stable cache entry across re-renders within the
  // same minute. (Cross-minute drift means a fresh fetch — acceptable.)
  const createdAfter = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- intentional once-per-mount snapshot; minute-level drift is acceptable per the comment above
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return new Date(cutoff).toISOString();
  }, []);

  const query = useTasks(0, 50, {
    status: TaskStatus.failed,
    created_after: createdAfter,
  });

  const data = useMemo<FailedTaskRow[]>(() => {
    const items = (query.data?.items ?? []) as Task[];
    return items.map((t) => ({
      id: t.id,
      title: t.prompt?.split("\n")[0]?.slice(0, 80) ?? `Task #${t.id}`,
      project_id: t.project_id,
      created_at: t.created_at,
    }));
  }, [query.data]);

  return { data, isLoading: query.isLoading, error: query.error };
}
