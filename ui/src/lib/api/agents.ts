import { apiFetch } from "./core";

// --- Agent questions (AskUserQuestion tool) ---

export interface AgentQuestionItem {
  id: number;
  requestId: string;
  question: string;
  toolUseId: string;
  createdAt: string | null;
}

export type AgentQuestionKind = "task" | "chat";

/** List pending agent questions for a task or chat. Used for hydration. */
export function fetchAgentQuestions(
  kind: AgentQuestionKind,
  id: string,
): Promise<{ items: AgentQuestionItem[] }> {
  const base = kind === "task" ? `/tasks/${id}` : `/chats/${id}`;
  return apiFetch(`${base}/questions`);
}

/** Answer a pending agent question. Returns { ok, taskStatus? }. */
export function answerAgentQuestion(args: {
  kind: AgentQuestionKind;
  id: string;
  requestId: string;
  answer: string;
}): Promise<{ ok: boolean; taskStatus?: string | null }> {
  const { kind, id, requestId, answer } = args;
  const base = kind === "task" ? `/tasks/${id}` : `/chats/${id}`;
  return apiFetch(`${base}/question/${encodeURIComponent(requestId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}
