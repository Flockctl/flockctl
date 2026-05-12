/**
 * `useAttentionInbox` — pure client-side merge of the three attention
 * sources into a single priority-sorted feed for the inbox surface.
 *
 * Design (parent slice 24-ui-redesign-working-surfaces/04-attention, T00):
 *
 *   - No new endpoints. Each source hook
 *     (`useAgentQuestionsAll` / `useMissionProposalsAll` /
 *     `useFailedTasks24h`) lives in `./attention-sources.ts` and owns
 *     its own React Query cache; this hook only stitches their results.
 *
 *   - Failure isolation. If ONE source errors, the other two still
 *     render their rows. The failing source contributes zero items;
 *     its `error` lands in `partialErrors[]` so the page can show a
 *     non-fatal banner without hiding the inbox.
 *
 *   - Stable sort:
 *       1. `priority`: `critical` (failed tasks, future budget warnings)
 *          comes before `normal` (agent questions, mission proposals).
 *       2. `created_at` DESC (newest first) within each priority bucket.
 *     Implemented via a single `Array.prototype.sort` with a stable
 *     comparator — ES2019+ guarantees a stable sort, so equal-priority
 *     equal-time items preserve insertion order (agent questions first,
 *     then mission proposals, then failed tasks).
 *
 *   - Item shape is a flat union (`source` discriminator) so the row
 *     component (`AttentionRow`, T01) can switch on `source` without
 *     re-fetching anything to render context.
 */

import { useMemo } from "react";
import {
  useAgentQuestionsAll,
  useMissionProposalsAll,
  useFailedTasks24h,
  type AgentQuestionRow,
  type MissionProposalRow,
  type FailedTaskRow,
} from "./attention-sources";
import { parseServerTimestamp } from "@/lib/utils";

export type AttentionInboxPriority = "critical" | "normal";
export type AttentionInboxSource =
  | "agent_question"
  | "mission_proposal"
  | "failed_task";

export interface AttentionInboxItem {
  /** Stable, kind-aware key safe to use as a React list key. */
  key: string;
  source: AttentionInboxSource;
  priority: AttentionInboxPriority;
  title: string;
  context: string | null;
  href: string;
  /** Epoch milliseconds — uniform across sources for a single sort pass. */
  created_at: number;
}

export interface UseAttentionInboxResult {
  items: AttentionInboxItem[];
  isLoading: boolean;
  /**
   * Errors from any source that failed. Empty when all three sources
   * resolved successfully. Order is stable: agent-questions, then
   * mission-proposals, then failed-tasks.
   */
  partialErrors: unknown[];
}

/**
 * Map an agent-question row to the unified inbox item. Questions surface
 * the human-readable prompt as the title and the entity (`task_question`
 * carries `task_id`, `chat_question` carries `chat_id`) for context.
 */
function mapAgentQuestion(row: AgentQuestionRow): AttentionInboxItem {
  const isTask = row.kind === "task_question";
  const entityId = isTask ? row.task_id : row.chat_id;
  const created = parseTimestampSafe(row.created_at);
  return {
    key: `agent_question:${entityId}:${row.request_id}`,
    source: "agent_question",
    priority: "normal",
    title: row.question,
    context: isTask ? `Task #${entityId}` : `Chat #${entityId}`,
    href: isTask ? `/tasks/${entityId}` : `/chats/${entityId}`,
    created_at: created,
  };
}

function mapMissionProposal(row: MissionProposalRow): AttentionInboxItem {
  return {
    key: `mission_proposal:${row.mission_id}:${row.id}`,
    source: "mission_proposal",
    priority: "normal",
    title: row.title,
    context: row.context ?? `Mission ${row.mission_id}`,
    href: `/missions/${row.mission_id}`,
    // Mission events store `created_at` as epoch SECONDS (snake_case row
    // off the `mission_events` table). Normalize to ms so the merged
    // comparator can sort across sources without a per-source branch.
    created_at: parseTimestampSafe(row.created_at),
  };
}

function mapFailedTask(row: FailedTaskRow): AttentionInboxItem {
  return {
    key: `failed_task:${row.id}`,
    source: "failed_task",
    priority: "critical",
    title: row.title,
    context: row.project_id ? `Project ${row.project_id}` : null,
    href: `/tasks/${row.id}`,
    created_at: parseTimestampSafe(row.created_at),
  };
}

/**
 * Coerce a wire timestamp to epoch ms. Accepts ISO strings (`AttentionItem`
 * `since` / `created_at`), numeric epoch seconds (mission proposals), or
 * numeric epoch ms (defensive fallback). NaN inputs collapse to 0 so the
 * sort doesn't blow up on a bad row.
 */
function parseTimestampSafe(input: string | number): number {
  if (typeof input === "number") {
    // Heuristic: anything below 10^12 is seconds, above is ms.
    return input < 1e12 ? input * 1000 : input;
  }
  // Routes upstream emit ISO with `Z`, but defensive: bare SQLite
  // `"YYYY-MM-DD HH:MM:SS"` would `Date.parse()` as local time and skew
  // the sort by the user's UTC offset. `parseServerTimestamp` normalises.
  const ms = parseServerTimestamp(input).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Comparator: critical first, then newest-first. Stable when equal so
 * equal-priority same-instant rows preserve their source order.
 */
function byPriorityThenTimeDesc(
  a: AttentionInboxItem,
  b: AttentionInboxItem,
): number {
  if (a.priority !== b.priority) return a.priority === "critical" ? -1 : 1;
  return b.created_at - a.created_at;
}

export function useAttentionInbox(): UseAttentionInboxResult {
  const q = useAgentQuestionsAll();
  const p = useMissionProposalsAll();
  const t = useFailedTasks24h();

  const items = useMemo<AttentionInboxItem[]>(() => {
    // Errored sources contribute zero rows — `data` should already be
    // empty in that case (the source hooks guard this), but we treat the
    // presence of `error` as the canonical signal and skip mapping
    // altogether to keep the merge ironclad against an unexpected
    // not-empty-but-also-failed shape.
    const fromQ = q.error ? [] : q.data.map(mapAgentQuestion);
    const fromP = p.error ? [] : p.data.map(mapMissionProposal);
    const fromT = t.error ? [] : t.data.map(mapFailedTask);
    const merged = [...fromQ, ...fromP, ...fromT];
    return merged.sort(byPriorityThenTimeDesc);
  }, [q.data, q.error, p.data, p.error, t.data, t.error]);

  const isLoading = q.isLoading || p.isLoading || t.isLoading;

  const partialErrors = useMemo<unknown[]>(() => {
    const errs: unknown[] = [];
    if (q.error) errs.push(q.error);
    if (p.error) errs.push(p.error);
    if (t.error) errs.push(t.error);
    return errs;
  }, [q.error, p.error, t.error]);

  return { items, isLoading, partialErrors };
}
