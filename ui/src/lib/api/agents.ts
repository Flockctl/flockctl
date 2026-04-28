import { apiFetch } from "./core";

// --- Agent questions (AskUserQuestion tool) ---

export interface AgentQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AgentQuestionItem {
  id: number;
  requestId: string;
  question: string;
  toolUseId: string;
  createdAt: string | null;
  /**
   * Multiple-choice picker fields (M05 slice 02). All three are optional so
   * the legacy free-form shape is still valid. `options` is null/absent for
   * free-form questions; when present it carries the structured choices the
   * `AgentQuestionPrompt` component renders as radios or checkboxes
   * (driven by `multiSelect`). `header` is the short uppercase chip rendered
   * above the choices.
   */
  options?: AgentQuestionOption[] | null;
  multiSelect?: boolean;
  header?: string | null;
}

export type AgentQuestionKind = "task" | "chat";

/** List pending agent questions for a task or chat. Used for hydration.
 *
 * `rawKeys: true` preserves the server's camelCase response shape — the
 * WS handler in `useChatEventStream` already builds items with
 * `requestId` / `multiSelect` to match `AgentQuestionItem`, and the
 * default `apiFetch` snake-case conversion would silently desynchronise
 * the two paths (REST hydration would produce `request_id`, WS pushes
 * would produce `requestId`, and consumers reading `.requestId` would
 * see `undefined` on the REST path). Skipping the conversion keeps the
 * cache shape stable across both sources. */
export function fetchAgentQuestions(
  kind: AgentQuestionKind,
  id: string,
): Promise<{ items: AgentQuestionItem[] }> {
  const base = kind === "task" ? `/tasks/${id}` : `/chats/${id}`;
  return apiFetch(`${base}/questions`, { rawKeys: true });
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
