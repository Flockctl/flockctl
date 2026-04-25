import { apiFetch } from "./core";

// --- Attention ---

/**
 * A single inbox row — discriminated on `kind`. Mirrors the backend shape
 * in `src/services/attention.ts` after camelCase→snake_case conversion by
 * `apiFetch`. `task_id` / `chat_id` / `project_id` are stringified IDs (see
 * the id-suffix rule in `toSnakeKeys`).
 *
 * Only `task_approval` carries a user-facing `title`; the permission variants
 * intentionally omit it (tool args can contain secrets, so the aggregator
 * strips everything but the tool name). The UI fills in a fallback like
 * `Task #N` / `Chat #N` when rendering those rows.
 */
export type AttentionItem =
  | {
      kind: "task_approval";
      task_id: string;
      project_id: string;
      title: string;
      since: string;
    }
  | {
      kind: "chat_approval";
      chat_id: string;
      project_id: string | null;
      title: string;
      since: string;
    }
  | {
      kind: "task_permission";
      task_id: string;
      project_id: string;
      request_id: string;
      tool: string;
      since: string;
    }
  | {
      kind: "chat_permission";
      chat_id: string;
      project_id: string | null;
      request_id: string;
      tool: string;
      since: string;
    };

export interface AttentionResponse {
  items: AttentionItem[];
  total: number;
}

export async function fetchAttention(): Promise<AttentionResponse> {
  return apiFetch("/attention");
}
