import { useParams, Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  useTask,
  useTaskLogStream,
  useCancelTask,
  useRerunTask,
  useApproveTask,
  useRejectTask,
  useUsageSummary,
  useUpdateTask,
  useUpdateProject,
  useUpdateWorkspace,
  useProject,
  useAgentQuestions,
  useAnswerAgentQuestion,
} from "@/lib/hooks";
import { fetchTaskDiff, respondToPermission } from "@/lib/api";
import { formatTimestamp, formatLogTime } from "@/lib/format";
import { AgentQuestionPrompt } from "@/components/AgentQuestionPrompt";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import { TaskStatusBadge } from "@/components/task-status-badge";
import { InlineDiff } from "@/components/InlineDiff";
import { ConnectionState } from "@/lib/ws";
import type { TaskStatus, PermissionMode } from "@/lib/types";
import { ArrowLeft, ChevronDown } from "lucide-react";

function statusVariant(
  status: TaskStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
      return "default";
    case "queued":
    case "assigned":
      return "secondary";
    case "failed":
    case "timed_out":
      return "destructive";
    case "done":
    case "pending_approval":
      return "outline";
    default:
      return "secondary";
  }
}


function extractUserPrompt(prompt: string): string {
  const marker = "## User Description";
  const start = prompt.indexOf(marker);
  if (start < 0) return prompt;
  const bodyStart = start + marker.length;
  const rest = prompt.slice(bodyStart);
  const nextHeading = rest.search(/\n##\s/);
  const body = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return body.trim();
}

function logLineClass(streamType: string): string {
  switch (streamType) {
    case "stderr":
      return "text-destructive";
    case "tool_call":
      return "text-blue-600 dark:text-blue-400";
    case "tool_result":
      return "text-muted-foreground text-xs";
    case "permission":
      return "text-amber-600 dark:text-amber-400 font-medium";
    default:
      return "";
  }
}

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const TERMINAL_STATUSES = ["done", "failed", "cancelled", "timed_out"];
  const { data: task, isLoading: taskLoading, error: taskError } = useTask(taskId ?? "", {
    refetchInterval: (query) => {
      const t = query.state.data;
      if (t && TERMINAL_STATUSES.includes(t.status)) return false;
      return 5_000;
    },
  });
  const { logs, metrics, permissionRequests, dismissPermissionRequest, isLoading: logsLoading, connectionState } = useTaskLogStream(taskId ?? "");
  const { question: agentQuestion } = useAgentQuestions({ kind: "task", id: taskId ?? null });
  const answerAgentQuestionMutation = useAnswerAgentQuestion();
  const cancelTaskMutation = useCancelTask();
  const rerunTaskMutation = useRerunTask();
  const approveTaskMutation = useApproveTask();
  const rejectTaskMutation = useRejectTask();
  const updateTaskMutation = useUpdateTask();
  const updateProjectMutation = useUpdateProject();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const { data: project } = useProject(task?.project_id ?? "");
  const [diffData, setDiffData] = useState<{ diff: string; summary: string | null; truncated: boolean } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);

  async function handleAllow(
    requestId: string,
    scope: "once" | "task" | "project" | "workspace",
  ) {
    try {
      if (scope === "task" && taskId) {
        await updateTaskMutation.mutateAsync({
          taskId,
          data: { permission_mode: "bypassPermissions" },
        });
      } else if (scope === "project" && task?.project_id) {
        await updateProjectMutation.mutateAsync({
          id: task.project_id,
          data: { permission_mode: "bypassPermissions" },
        });
      } else if (scope === "workspace" && project?.workspace_id != null) {
        await updateWorkspaceMutation.mutateAsync({
          id: String(project.workspace_id),
          data: { permission_mode: "bypassPermissions" },
        });
      }
      await respondToPermission(taskId!, requestId, "allow");
      dismissPermissionRequest(requestId);
    } catch (err) {
      console.error("Failed to allow permission", err);
    }
  }

  function handleChangePermissionMode(mode: PermissionMode | null) {
    if (!taskId) return;
    updateTaskMutation.mutate({ taskId, data: { permission_mode: mode } });
  }

  async function loadDiff() {
    if (!taskId) return;
    setDiffLoading(true);
    try {
      const data = await fetchTaskDiff(taskId);
      setDiffData({ diff: data.diff, summary: data.summary ?? null, truncated: !!data.truncated });
      setShowDiff(true);
    } catch { /* failed to load diff */ }
    setDiffLoading(false);
  }

  const { data: usage } = useUsageSummary(
    { task_id: taskId ?? "" },
    { enabled: !!taskId },
  );
  const keyName = (() => {
    if (!task?.assigned_key_id) return "Auto";
    if (task.assigned_key_label) return task.assigned_key_label;
    return `Key #${task.assigned_key_id}`;
  })();
  const modelDisplay = (() => {
    const usedModels = usage?.by_model ? Object.keys(usage.by_model) : [];
    if (usedModels.length > 0) return usedModels.join(", ");
    if (task?.model) return task.model;
    return "Default";
  })();

  // Auto-scroll: scroll to bottom on new logs unless user has scrolled up
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  if (!taskId) {
    return <p className="text-destructive">Missing task ID.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/tasks"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to tasks
      </Link>

      {/* Metadata card */}
      {taskLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-64" />
            ))}
          </CardContent>
        </Card>
      )}

      {taskError && (
        <p className="text-destructive">
          Failed to load task: {taskError.message}
        </p>
      )}

      {task && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              <span className="font-mono text-sm">{String(task.id).slice(0, 8)}</span>
              <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
              <div className="ml-auto flex gap-2">
                {(task.status === "queued" || task.status === "assigned" || task.status === "running") && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={cancelTaskMutation.isPending}
                    onClick={() => cancelTaskMutation.mutate(task.id)}
                  >
                    {cancelTaskMutation.isPending ? "Cancelling..." : "Cancel"}
                  </Button>
                )}
                {(task.status === "failed" || task.status === "timed_out") && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rerunTaskMutation.isPending}
                    onClick={() => rerunTaskMutation.mutate(task.id)}
                  >
                    {rerunTaskMutation.isPending ? "Re-running..." : "Re-run"}
                  </Button>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
              <div>
                <span className="text-muted-foreground">AI Key</span>
                <p>{task.assigned_key_id ? keyName : "Auto"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Model</span>
                <p className="font-mono text-xs">{modelDisplay}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Timeout</span>
                <p>{task.timeout_seconds}s</p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p className="text-xs">{formatTimestamp(task.created_at)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Started</span>
                <p className="text-xs">{formatTimestamp(task.started_at)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Completed</span>
                <p className="text-xs">{formatTimestamp(task.completed_at)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Exit Code</span>
                <p className="font-mono">
                  {task.exit_code != null ? task.exit_code : "-"}
                </p>
              </div>
              <div className="col-span-2 md:col-span-3">
                <span className="text-muted-foreground">Permission mode</span>
                <div className="mt-1 max-w-sm">
                  <PermissionModeSelect
                    value={task.permission_mode}
                    onChange={handleChangePermissionMode}
                    inheritLabel="inherit from project / workspace"
                    compact
                    disabled={updateTaskMutation.isPending}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rerun chain: parent + children, so the relationship between a failed
          task and its rerun attempts is visible without cross-referencing the
          list. Shown only when there's at least one link to display. */}
      {task && (task.parent_task_id || (task.children && task.children.length > 0)) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rerun chain</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {task.parent_task_id && (
              <div>
                <span className="text-muted-foreground">Rerun of </span>
                <Link
                  to={`/tasks/${task.parent_task_id}`}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  #{String(task.parent_task_id).slice(0, 8)}
                </Link>
              </div>
            )}
            {task.children && task.children.length > 0 && (
              <div>
                <span className="text-muted-foreground">Re-runs</span>
                <ul className="mt-1 space-y-1">
                  {task.children.map((child) => (
                    <li key={child.id} className="flex items-center gap-2">
                      <Link
                        to={`/tasks/${child.id}`}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        #{String(child.id).slice(0, 8)}
                      </Link>
                      <TaskStatusBadge status={child.status} />
                      {child.label && (
                        <span className="truncate text-xs text-muted-foreground">
                          {child.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Prompt */}
      {task?.prompt && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border bg-muted/30 p-3 text-sm">
              {extractUserPrompt(task.prompt)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Prompt file (plan-driven execution tasks have no inline prompt) */}
      {!task?.prompt && task?.prompt_file && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prompt source</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This task reads its prompt from a plan spec file:
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded border bg-muted/30 p-3 font-mono text-xs">
              {task.prompt_file}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Approval banner */}
      {task?.status === "pending_approval" && (
        <Card className="border-amber-500">
          <CardContent className="flex items-center gap-4 py-4">
            <div className="flex-1">
              <p className="font-medium">Task awaiting approval</p>
              {task.git_diff_summary && (
                <p className="mt-1 font-mono text-sm text-muted-foreground">{task.git_diff_summary}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={loadDiff}
                disabled={diffLoading}
              >
                {diffLoading ? "Loading..." : "Show Diff"}
              </Button>
              <Button
                size="sm"
                disabled={approveTaskMutation.isPending}
                onClick={() => approveTaskMutation.mutate({ taskId: task.id })}
              >
                {approveTaskMutation.isPending ? "Approving..." : "Approve"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={rejectTaskMutation.isPending}
                onClick={() => rejectTaskMutation.mutate({ taskId: task.id })}
              >
                {rejectTaskMutation.isPending ? "Rejecting..." : "Reject"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Permission requests from the agent */}
      {permissionRequests.length > 0 && (
        <div className="space-y-2">
          {permissionRequests.map((req) => (
            <Card key={req.request_id} className="border-blue-500">
              <CardContent className="flex items-start gap-4 py-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">🔐 {req.title ?? `${req.tool_name} permission`}</p>
                  {req.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{req.description}</p>
                  )}
                  {req.decision_reason && (
                    <p className="mt-1 text-sm text-muted-foreground italic">{req.decision_reason}</p>
                  )}
                  <pre className="mt-2 max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-xs">
                    {JSON.stringify(req.tool_input, null, 2)}
                  </pre>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    onClick={() => handleAllow(req.request_id, "once")}
                  >
                    Allow once
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline">
                        Allow always
                        <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Bypass scope</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => handleAllow(req.request_id, "task")}>
                        For this task
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!task?.project_id}
                        onSelect={() => handleAllow(req.request_id, "project")}
                      >
                        For the project
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={project?.workspace_id == null}
                        onSelect={() => handleAllow(req.request_id, "workspace")}
                      >
                        For the workspace
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      await respondToPermission(taskId!, req.request_id, "deny");
                      dismissPermissionRequest(req.request_id);
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Git diff summary */}
      {task && task.status !== "pending_approval" && task.git_diff_summary && (
        <Card>
          <CardContent className="flex items-center gap-4 py-4">
            <div className="flex-1">
              <p className="font-mono text-sm">{task.git_diff_summary}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={loadDiff}
              disabled={diffLoading}
            >
              {diffLoading ? "Loading..." : "Show Diff"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Full diff viewer */}
      {showDiff && diffData && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Changes</span>
              <Button variant="ghost" size="sm" onClick={() => setShowDiff(false)}>Close</Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InlineDiff diff={diffData.diff} truncated={diffData.truncated} />
          </CardContent>
        </Card>
      )}

      {/* Metrics card — live during execution, from DB after completion */}
      {(task?.status === "running" || task?.status === "assigned" || metrics || (usage && usage.record_count > 0)) && (
        <Card>
          <CardHeader><CardTitle className="text-base">Metrics</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Input tokens</span>
                <p className="font-mono">
                  {(metrics?.input_tokens ?? task?.liveMetrics?.input_tokens ?? usage?.total_input_tokens ?? 0).toLocaleString()}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Output tokens</span>
                <p className="font-mono">
                  {(metrics?.output_tokens ?? task?.liveMetrics?.output_tokens ?? usage?.total_output_tokens ?? 0).toLocaleString()}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Total cost</span>
                <p className="font-mono">
                  ${(metrics?.total_cost_usd ?? task?.liveMetrics?.total_cost_usd ?? usage?.total_cost_usd ?? 0).toFixed(4)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Turns</span>
                <p className="font-mono">
                  {metrics?.turns ?? task?.liveMetrics?.turns ?? "-"}
                </p>
              </div>
              {(metrics?.cache_creation_tokens ?? task?.liveMetrics?.cache_creation_tokens ?? usage?.total_cache_creation_tokens ?? 0) > 0 && (
                <div>
                  <span className="text-muted-foreground">Cache write</span>
                  <p className="font-mono">
                    {(metrics?.cache_creation_tokens ?? task?.liveMetrics?.cache_creation_tokens ?? usage?.total_cache_creation_tokens ?? 0).toLocaleString()}
                  </p>
                </div>
              )}
              {(metrics?.cache_read_tokens ?? task?.liveMetrics?.cache_read_tokens ?? usage?.total_cache_read_tokens ?? 0) > 0 && (
                <div>
                  <span className="text-muted-foreground">Cache read</span>
                  <p className="font-mono">
                    {(metrics?.cache_read_tokens ?? task?.liveMetrics?.cache_read_tokens ?? usage?.total_cache_read_tokens ?? 0).toLocaleString()}
                  </p>
                </div>
              )}
              {((metrics?.duration_ms ?? task?.liveMetrics?.duration_ms) != null && (metrics?.duration_ms ?? task?.liveMetrics?.duration_ms ?? 0) > 0) && (
                <div>
                  <span className="text-muted-foreground">Duration</span>
                  <p className="font-mono">
                    {(() => {
                      const ms = metrics?.duration_ms ?? task?.liveMetrics?.duration_ms ?? 0;
                      return ms >= 60000
                        ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
                        : `${Math.round(ms / 1000)}s`;
                    })()}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent-raised clarification question (AskUserQuestion tool).
          Mounts above the log stream so it's the first thing a user sees
          when the task transitions to `waiting_for_input`. */}
      {agentQuestion && taskId && (
        <AgentQuestionPrompt
          question={agentQuestion.question}
          requestId={agentQuestion.requestId}
          // Picker-mode fields (M05 slice 02). Both REST hydration
          // (`fetchAgentQuestions` → `pendingQuestions` in task-executor)
          // and live WS frames (`useTaskStream`'s `agent_question` branch)
          // populate these — we just forward whichever shape landed in the
          // cache. Undefined/null collapses to free-form. Without this
          // forward the task page renders only the textarea even when the
          // underlying question carries structured `options` (the bug QA
          // hit when /attention rendered the radio group correctly but
          // the task page showed only "Type your answer…").
          {...(agentQuestion.options ? { options: agentQuestion.options } : {})}
          multiSelect={agentQuestion.multiSelect ?? false}
          {...(agentQuestion.header ? { header: agentQuestion.header } : {})}
          onAnswer={async (answer) => {
            await answerAgentQuestionMutation.mutateAsync({
              kind: "task",
              id: taskId,
              requestId: agentQuestion.requestId,
              answer,
            });
          }}
        />
      )}

      {/* Log viewer */}
      <Card className="flex h-[500px] flex-col">
        <CardHeader className="flex-none pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Logs</span>
            <span className="text-xs font-normal text-muted-foreground">
              {connectionState === ConnectionState.OPEN
                ? "Connected"
                : connectionState === ConnectionState.CONNECTING
                  ? "Connecting..."
                  : "Disconnected"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col pb-4">
          {logsLoading && (
            <div className="space-y-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          )}
          {!logsLoading && logs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No log output yet.
            </p>
          )}
          {logs.length > 0 && (
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-auto rounded border bg-muted/30 p-3 font-mono text-sm"
            >
              {logs.map((log) => (
                <div
                  key={log.id}
                  className={`flex gap-2 py-0.5 leading-relaxed ${logLineClass(log.stream_type)}`}
                >
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatLogTime(log.timestamp)}
                  </span>
                  <span className="whitespace-pre-wrap break-all">
                    {log.content}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
