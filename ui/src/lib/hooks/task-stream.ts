import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type WSMessage } from "../ws";
import {
  fetchTaskPendingPermissions,
  type AgentQuestionItem,
} from "../api";
import type { TaskLog, TaskMetrics } from "../types";
import { queryKeys, type PermissionRequestUI } from "./core";
import { useTaskLogs } from "./tasks";

// --- Live log stream hook ---

export function useTaskLogStream(taskId: string) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [metrics, setMetrics] = useState<TaskMetrics | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequestUI[]>([]);
  const seenIds = useRef(new Set<string>());
  const queryClient = useQueryClient();

  // Fetch historical logs
  const {
    data: historicalLogs,
    isLoading,
    error,
  } = useTaskLogs(taskId);

  // Seed logs from REST response
  useEffect(() => {
    if (historicalLogs) {
      seenIds.current = new Set(historicalLogs.map((l) => l.id));
      setLogs(historicalLogs);
    }
  }, [historicalLogs]);

  // Hydrate any still-pending permission requests on mount / taskId change.
  // WebSocket events aren't replayed on reconnect, so a page reload while a
  // task is blocked on a permission prompt would otherwise hide the card
  // while the session stays stuck waiting for a response.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    fetchTaskPendingPermissions(taskId)
      .then((res) => {
        if (cancelled) return;
        setPermissionRequests((prev) => {
          const existing = new Set(prev.map((r) => r.request_id));
          const merged = [...prev];
          for (const item of res.items) {
            if (!existing.has(item.request_id)) merged.push(item);
          }
          return merged;
        });
      })
      .catch(() => { /* no active session — nothing to hydrate */ });
    return () => { cancelled = true; };
  }, [taskId]);

  // Stable onMessage ref to avoid WebSocket reconnects
  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback(
    (msg: WSMessage) => {
      // Backend sends { type, payload: {...} } or flat { type, ...fields }
      const data = (msg.payload ?? msg) as Record<string, unknown>;
      if (msg.type === "log_line") {
        const logId =
          String(data.id ?? `ws-${data.timestamp ?? Date.now()}`);
        if (!seenIds.current.has(logId)) {
          seenIds.current.add(logId);
          const newLog: TaskLog = {
            id: logId,
            task_id: String(data.task_id ?? taskId),
            content: String(data.content ?? ""),
            stream_type: String(data.stream_type ?? "stdout"),
            timestamp:
              String(data.timestamp ?? new Date().toISOString()),
          };
          setLogs((prev) => [...prev, newLog]);
        }
      } else if (msg.type === "task_metrics" || (msg as any).type === "task_metrics") {
        setMetrics({
          input_tokens: Number(data.input_tokens ?? 0),
          output_tokens: Number(data.output_tokens ?? 0),
          cache_creation_tokens: Number(data.cache_creation_tokens ?? 0),
          cache_read_tokens: Number(data.cache_read_tokens ?? 0),
          total_cost_usd: Number(data.total_cost_usd ?? 0),
          turns: Number(data.turns ?? 0),
          duration_ms: Number(data.duration_ms ?? 0),
        });
        // Also invalidate usage queries so the Cost card updates
        queryClient.invalidateQueries({
          queryKey: queryKeys.usageSummary({ task_id: taskId }),
        });
      } else if (msg.type === "permission_request") {
        const req: PermissionRequestUI = {
          request_id: String(data.request_id),
          tool_name: String(data.tool_name),
          tool_input: (data.tool_input as Record<string, unknown>) ?? {},
          title: data.title ? String(data.title) : null,
          display_name: data.display_name ? String(data.display_name) : null,
          description: data.description ? String(data.description) : null,
          decision_reason: data.decision_reason ? String(data.decision_reason) : null,
          tool_use_id: String(data.tool_use_id ?? ""),
        };
        setPermissionRequests((prev) => [...prev, req]);
      } else if (msg.type === "agent_question") {
        // Push into the shared agent-question cache so `useAgentQuestions`
        // (which can be mounted anywhere) re-renders without opening its own
        // WebSocket. Idempotent on request_id.
        const item: AgentQuestionItem = {
          id: Number(data.db_id ?? 0),
          requestId: String(data.request_id),
          question: String(data.question ?? ""),
          toolUseId: String(data.tool_use_id ?? ""),
          createdAt: data.created_at ? String(data.created_at) : null,
        };
        queryClient.setQueryData<{ items: AgentQuestionItem[] }>(
          queryKeys.agentQuestion("task", taskId),
          (prev) => {
            const items = prev?.items ?? [];
            if (items.some((q) => q.requestId === item.requestId)) {
              return prev ?? { items };
            }
            return { items: [...items, item] };
          },
        );
      } else if (msg.type === "agent_question_resolved") {
        const requestId = String(data.request_id);
        queryClient.setQueryData<{ items: AgentQuestionItem[] }>(
          queryKeys.agentQuestion("task", taskId),
          (prev) => {
            if (!prev) return { items: [] };
            return {
              items: prev.items.filter((q) => q.requestId !== requestId),
            };
          },
        );
      } else if (
        msg.type === "task_started" ||
        msg.type === "task_done" ||
        msg.type === "task_status"
      ) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(taskId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.usageSummary({ task_id: taskId }),
        });
      }
    },
    [taskId, queryClient],
  );

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  const { state: connectionState } = useWebSocket({
    path: `/ws/ui/tasks/${taskId}/logs`,
    onMessage: stableOnMessage,
    enabled: !!taskId,
  });

  // Refetch task status when WebSocket reconnects (handles missed messages)
  const prevConnectionState = useRef(connectionState);
  useEffect(() => {
    if (
      prevConnectionState.current !== "open" &&
      connectionState === "open"
    ) {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.usageSummary({ task_id: taskId }),
      });
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, taskId, queryClient]);

  const dismissPermissionRequest = useCallback((requestId: string) => {
    setPermissionRequests((prev) => prev.filter((r) => r.request_id !== requestId));
  }, []);

  return { logs, metrics, permissionRequests, dismissPermissionRequest, isLoading, error, connectionState };
}
