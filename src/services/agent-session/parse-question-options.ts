// ─── Shared `agent_questions.options` parser ───
//
// The `agent_questions.options` column stores a JSON-encoded
// `QuestionOption[]` (label + optional description + optional preview) when
// the agent fires `AskUserQuestion` with multi-choice candidates, or NULL
// for free-form prompts.
//
// Four call sites previously inlined the same try/JSON.parse/check-Array
// pattern (attention.ts, agent-interaction.ts, chat-executor.ts,
// task-executor/executor-questions.ts). Each of them runs in a hot path
// (attention is polled, executor-questions fires per task transition,
// chat-executor fires per chat resume), so a shared helper saves both
// duplicated logic AND repeat JSON.parse work on the SAME row reads.
//
// Why a free function rather than a method on `QuestionRow`: the column is
// stored as the raw JSON text and read as part of larger row-projection
// types in different services. Plumbing a parser through every row-shape
// just to read one column adds more friction than the duplication it
// removes. The function is pure + tiny.

import type { QuestionOption } from "./types.js";

/**
 * Parse a raw `agent_questions.options` cell into a `QuestionOption[]` or
 * `null`. Returns `null` for missing / malformed JSON / non-array shapes —
 * callers that need to distinguish "no options" from "empty options" can
 * check `result === null` vs `result.length === 0`.
 *
 * When `requestId` is provided, a malformed-JSON failure logs a console
 * warning naming the affected row id so operators can find the offender.
 * The log is opt-in to keep the function pure for callers that don't have
 * a row id handy (e.g. broadcast paths).
 */
export function parseQuestionOptions(
  raw: string | null | undefined,
  requestId?: string,
): QuestionOption[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QuestionOption[]) : null;
  } catch (err) {
    // Malformed JSON in the DB row is non-fatal: drop to free-form. The four
    // production call sites all behave the same way (treat null as "no
    // options"), so swallowing the parse error keeps them in sync.
    if (requestId) {
      console.warn(
        `[attention] failed to parse agent_questions.options for ${requestId}:`,
        err,
      );
    }
    return null;
  }
}
