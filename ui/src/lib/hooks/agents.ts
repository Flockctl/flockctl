import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgentQuestions,
  answerAgentQuestion,
  type AgentQuestionKind,
  type AgentQuestionItem,
} from "../api";
import { queryKeys } from "./core";

// --- Agent questions (AskUserQuestion tool) ---

/**
 * Observes the currently pending agent question (if any) for a task or chat.
 *
 * State lives in the React Query cache under `queryKeys.agentQuestion(kind, id)`.
 * Seeding happens via a REST fetch on mount (`GET /tasks/:id/questions` or
 * `GET /chats/:id/questions`); live updates come from the WS handlers inside
 * `useTaskLogStream` / `useChatEventStream`, which push `agent_question` and
 * `agent_question_resolved` frames into the same cache key. That means this
 * hook does NOT open its own WebSocket — the enclosing page already owns the
 * `task:<id>` / `chat:<id>` subscription.
 *
 * Returns the oldest pending question (usually 0 or 1 rows), keyed by
 * `request_id` so duplicate pushes are idempotent.
 */
export function useAgentQuestions({
  kind,
  id,
}: {
  kind: AgentQuestionKind;
  id: string | null;
}): {
  question: AgentQuestionItem | null;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: id
      ? queryKeys.agentQuestion(kind, id)
      : ["agent-question", kind, "__none__"],
    queryFn: () => fetchAgentQuestions(kind, id!),
    enabled: !!id,
    // Re-fetch on mount so reloads after a question was emitted still hydrate
    // the prompt — WS frames aren't replayed on reconnect.
    staleTime: 0,
  });
  const items = query.data?.items ?? [];
  const question: AgentQuestionItem | null = items[0] ?? null;
  return { question, isLoading: query.isLoading };
}

/**
 * Mutation for POSTing an answer to a pending agent question. On success it
 * eagerly clears the local cache entry for the request id — the server also
 * emits `agent_question_resolved` over WS, so we're idempotent either way.
 */
export function useAnswerAgentQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      kind: AgentQuestionKind;
      id: string;
      requestId: string;
      answer: string;
    }) => answerAgentQuestion(args),
    onSuccess: (_result, args) => {
      queryClient.setQueryData<{ items: AgentQuestionItem[] }>(
        queryKeys.agentQuestion(args.kind, args.id),
        (prev) => {
          if (!prev) return { items: [] };
          return {
            items: prev.items.filter((q) => q.requestId !== args.requestId),
          };
        },
      );
    },
  });
}
