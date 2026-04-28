import { apiFetch } from "./core";

/**
 * Surface-agnostic answerer for `AskUserQuestion` prompts.
 *
 * Both task and chat sessions expose the same shape of pending question
 * (see `agent_questions` table) and the same answer endpoint
 * `POST /{tasks|chats}/:id/question/:requestId/answer` with body
 * `{ answer: string }`. The free function lets row-shaped consumers
 * (notably the inbox, where one row may be a `task_question` and the next
 * a `chat_question`) avoid branching on surface inside their `onAnswer`
 * handler.
 *
 * Unrelated to the existing `answerAgentQuestion` helper in `./agents.ts`,
 * which is shaped for the per-task/chat detail-page consumers and still
 * used there. Keeping both keeps the call sites idiomatic without forcing
 * a wider refactor for this slice.
 */
export type QuestionSurface = "task" | "chat";

export async function answerQuestion(
  surface: QuestionSurface,
  id: string,
  requestId: string,
  answer: string,
): Promise<{ ok: boolean; taskStatus?: string | null }> {
  const base = surface === "task" ? `/tasks/${id}` : `/chats/${id}`;
  return apiFetch(`${base}/question/${encodeURIComponent(requestId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}
