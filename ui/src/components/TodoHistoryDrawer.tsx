import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useChatTodoAgents, useChatTodoHistory } from "@/lib/hooks";
import { timeAgo } from "@/lib/utils";
import {
  CheckCircle2,
  Circle,
  Loader2,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type {
  ChatTodoAgent,
  ChatTodoHistoryItem,
  ChatTodoItem,
  ChatTodoWithCompletedAt,
} from "@/lib/api";

/**
 * Read-only drawer that surfaces the archived TodoWrite snapshots for a chat,
 * grouped by agent.
 *
 * Layout per design "#3 latest-per-agent + #2 collapsible groups":
 *   - One tab per agent (main + every sub-agent spawned via the Task tool).
 *   - The active tab shows the LATEST snapshot expanded (with per-todo
 *     completion timestamps for completed items).
 *   - Underneath, a collapsible "Older snapshots" section lazy-loads the
 *     paginated history scoped to that agent only — no fetch happens until
 *     the user clicks to expand, so the common "I just want the current
 *     state" case stays cheap.
 *
 * IMPORTANT: this component is read-only by design. It renders snapshots
 * that already exist in `chat_todos`; it must not expose edit or delete
 * controls. Adding write affordances here would conflict with the snapshot
 * contract (one immutable row per TodoWrite emission).
 */
interface TodoHistoryDrawerProps {
  chatId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TodoHistoryDrawer({
  chatId,
  open,
  onOpenChange,
}: TodoHistoryDrawerProps) {
  // Fetch the per-agent grouping only when the drawer is open. The hook is
  // gated on chatId; passing null keeps the underlying useQuery disabled
  // (matches `useChatTodoHistory`'s convention).
  const agents = useChatTodoAgents(open ? chatId : null);

  const items = agents.data?.items ?? [];
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Auto-pick the first tab once the agents list arrives. Reset when chat
  // changes so a stale agent key from another chat can't survive switching.
  useEffect(() => {
    if (items.length === 0) {
      if (activeKey !== null) setActiveKey(null);
      return;
    }
    const stillPresent = activeKey !== null && items.some((a) => a.key === activeKey);
    if (!stillPresent && items[0]) setActiveKey(items[0].key);
  }, [items, activeKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl md:max-w-4xl lg:max-w-5xl p-0 gap-0"
        data-testid="todo-history-drawer"
      >
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Todo history
          </DialogTitle>
          <DialogDescription>
            Read-only archive of TodoWrite snapshots for this chat, one tab
            per agent.
          </DialogDescription>
        </DialogHeader>

        <div className="h-[60vh] overflow-hidden">
          {agents.isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : agents.isError ? (
            <p
              className="p-4 text-xs text-destructive"
              data-testid="todo-history-error"
            >
              {agents.error instanceof Error
                ? agents.error.message
                : "Failed to load history"}
            </p>
          ) : items.length === 0 ? (
            <p
              className="p-4 text-xs text-muted-foreground"
              data-testid="todo-history-empty"
            >
              No snapshots yet.
            </p>
          ) : (
            <Tabs
              value={activeKey ?? items[0]!.key}
              onValueChange={setActiveKey}
              className="h-full flex flex-col gap-0"
            >
              <div className="border-b px-3 pt-2 overflow-x-auto">
                <TabsList
                  className="h-auto bg-transparent p-0 gap-1"
                  data-testid="todo-history-tabs"
                >
                  {items.map((agent) => (
                    <TabsTrigger
                      key={agent.key}
                      value={agent.key}
                      data-testid="todo-history-tab"
                      data-agent-key={agent.key}
                      className="data-[state=active]:bg-muted rounded-md px-3 py-1.5"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate max-w-[180px]" title={agent.label}>
                          {agent.label}
                        </span>
                        {agent.subagent_type && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1 h-4">
                            {agent.subagent_type}
                          </Badge>
                        )}
                        {agent.latest && (
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {agent.latest.counts.completed}/{agent.latest.counts.total}
                          </span>
                        )}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {items.map((agent) => (
                <TabsContent
                  key={agent.key}
                  value={agent.key}
                  className="flex-1 overflow-auto m-0"
                >
                  <AgentPane chatId={chatId} agent={agent} />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One tab's body: the latest snapshot expanded at the top, then a
 * collapsible "Older snapshots" pane that lazy-loads the agent-scoped
 * paginated history on first expand.
 */
function AgentPane({ chatId, agent }: { chatId: string | null; agent: ChatTodoAgent }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const latest = agent.latest;
  // The "Older snapshots" group excludes the latest snapshot already
  // rendered above, so the count surfaced on the toggle button never lies
  // about what the user will see when they expand it.
  const olderCount = Math.max(0, agent.snapshot_count - 1);
  return (
    <div className="p-4 space-y-4" data-testid="todo-history-content">
      {!latest ? (
        <p className="text-xs text-muted-foreground">
          This agent has no snapshots yet.
        </p>
      ) : (
        <section
          aria-labelledby={`latest-${agent.key}`}
          data-testid="todo-history-latest"
        >
          <header className="flex items-center justify-between mb-2">
            <div>
              <h3
                id={`latest-${agent.key}`}
                className="text-sm font-semibold"
              >
                Latest snapshot
              </h3>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {new Date(latest.created_at).toLocaleString()} ·{" "}
                {latest.counts.completed} / {latest.counts.total} done
                {latest.counts.in_progress > 0 &&
                  ` · ${latest.counts.in_progress} in progress`}
              </p>
            </div>
          </header>
          {latest.todos.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This snapshot has no todos.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {latest.todos.map((todo, i) => (
                <TodoRow key={i} todo={todo} />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Older snapshots — collapsible, only fetches when expanded. The
          drawer's primary use case is "show me the current state" so we
          keep the older history pay-as-you-go to avoid an extra round-trip
          on every open. The chevron/heading state is local — closing the
          drawer resets it. */}
      {olderCount > 0 && (
        <section data-testid="todo-history-older">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            data-testid="todo-history-older-toggle"
            data-open={historyOpen ? "true" : "false"}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {historyOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Older snapshots ({olderCount})
          </button>
          {historyOpen && (
            <div className="mt-3 pl-4 border-l">
              <OlderSnapshots chatId={chatId} agentKey={agent.key} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Lazy-loaded list of snapshots older than the latest, scoped to one agent
 * via `?agent=`. Mounts only after the user expands the collapsible — see
 * `AgentPane`. Pagination is server-driven (offset/limit); the "Load more"
 * button mirrors the legacy single-pane behaviour.
 */
function OlderSnapshots({
  chatId,
  agentKey,
}: {
  chatId: string | null;
  agentKey: string;
}) {
  const {
    items,
    total,
    hasMore,
    isLoading,
    isError,
    error,
    loadMore,
    loadingMore,
    loadMoreError,
  } = useChatTodoHistory(chatId, 20, agentKey);

  // Drop the FIRST returned snapshot — it's the same row already shown in
  // the "Latest snapshot" section above. Without this the user would see
  // their current todos repeated under "Older snapshots".
  const olderItems = items.slice(1);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-xs text-destructive">
        {error?.message ?? "Failed to load older snapshots"}
      </p>
    );
  }
  if (olderItems.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No older snapshots.</p>
    );
  }
  return (
    <ul
      className="space-y-3"
      data-testid="todo-history-older-list"
    >
      {olderItems.map((snap) => (
        <OlderSnapshotItem key={snap.id} snap={snap} />
      ))}
      {(hasMore || loadingMore) && (
        <li>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void loadMore()}
            disabled={loadingMore || !hasMore}
            data-testid="todo-history-load-more"
          >
            {loadingMore
              ? "Loading…"
              : `Load more (${Math.max(0, total - items.length)})`}
          </Button>
          {loadMoreError && (
            <p className="mt-1 text-[11px] text-destructive">
              {loadMoreError.message}
            </p>
          )}
        </li>
      )}
    </ul>
  );
}

function OlderSnapshotItem({ snap }: { snap: ChatTodoHistoryItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      data-testid="todo-history-item"
      data-snapshot-id={snap.id}
      className="border rounded-md"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/50"
      >
        <span className="text-xs font-medium">{timeAgo(snap.created_at)}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-2">
          {snap.counts.completed} / {snap.counts.total} done
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {open && (
        <ul className="px-3 pb-3 pt-1 space-y-1.5 border-t">
          {snap.todos.map((todo, i) => (
            <TodoRow key={i} todo={todo} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Single todo row. Accepts either the annotated shape from the agents
 * endpoint (carries `completed_at`) or the bare history shape — completion
 * timestamp only renders when present.
 */
function TodoRow({
  todo,
}: {
  todo: ChatTodoItem | ChatTodoWithCompletedAt;
}) {
  const completedAt = "completed_at" in todo ? todo.completed_at : null;
  return (
    <li
      className="flex items-start gap-2 text-sm"
      data-testid="todo-history-todo-row"
      data-status={todo.status}
    >
      <span className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : todo.status === "in_progress" ? (
          <Loader2 className="h-4 w-4 text-blue-600" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span
          className={
            todo.status === "completed"
              ? "line-through text-muted-foreground"
              : ""
          }
        >
          {todo.status === "in_progress" && todo.active_form
            ? todo.active_form
            : todo.content}
        </span>
        {completedAt && (
          <span
            className="ml-2 text-[10px] text-muted-foreground tabular-nums"
            title={new Date(completedAt).toLocaleString()}
            data-testid="todo-completed-at"
          >
            ✓ {timeAgo(completedAt)}
          </span>
        )}
      </span>
    </li>
  );
}
