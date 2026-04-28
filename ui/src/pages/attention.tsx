import { useMemo } from "react";
import { useAttention, useProjects } from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { Inbox } from "lucide-react";
import { AttentionRow } from "@/components/attention/attention-row";
import type { Project } from "@/lib/types";
import type { AttentionItem } from "@/lib/api";

/**
 * Inbox page — flat list of items the user must act on right now
 * (task approvals + tool-permission prompts on running task/chat sessions).
 *
 * We intentionally render cards rather than a table: items are mixed-kind
 * (approvals vs. per-tool prompts) and each kind surfaces different context,
 * so a single-width row of columns would either truncate useful fields or
 * leave most cells empty. Cards scale to arbitrary per-kind detail without
 * forcing every variant into the same column grid.
 *
 * Shell contract (matches other pages under ui/src/pages):
 *  - Page title + count subtitle in a header that mirrors dashboard/tasks
 *  - Loading: a short stack of skeletons
 *  - Error: red destructive text, non-fatal (header still renders)
 *  - Empty: muted "Inbox is empty" illustration
 *  - Items: vertical stack of cards
 *
 * Data comes from `useAttention`, which owns the React Query cache and
 * invalidates on `attention_changed` WS frames — so this component never
 * holds a local copy of the list.
 *
 * We fetch projects ONCE at the page level (not per-row) and build a
 * `projectsById` map to avoid the obvious N+1 fetch storm when the inbox
 * has ten rows pointing at ten different projects. The map is passed down
 * to each row; if a project is missing from the map the row falls back to
 * `Project #N`, keeping the row renderable even on a stale projects list.
 */
export default function AttentionPage() {
  const { items, total, isLoading, error } = useAttention();
  const { data: projects } = useProjects();

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects ?? []) map.set(p.id, p);
    return map;
  }, [projects]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold sm:text-2xl">Inbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isLoading
            ? "Loading…"
            : total === 0
              ? "Nothing is waiting on you."
              : `${total} item${total === 1 ? "" : "s"} waiting on you.`}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          Failed to load inbox:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-16 text-center">
          <Inbox className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">Inbox is empty</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Approval requests and tool-permission prompts will appear here.
          </p>
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={attentionKey(item)}>
              <AttentionRow item={item} projectsById={projectsById} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A stable, kind-aware React key. `request_id` is unique per permission
 * prompt but does not exist on approvals, so we fall back to `task_id`
 * there. Prefix with `kind` so a task approval and a task permission for
 * the same task id never collide.
 */
function attentionKey(item: AttentionItem): string {
  switch (item.kind) {
    case "task_approval":
      return `task_approval:${item.task_id}`;
    case "chat_approval":
      return `chat_approval:${item.chat_id}`;
    case "task_permission":
      return `task_permission:${item.task_id}:${item.request_id}`;
    case "chat_permission":
      return `chat_permission:${item.chat_id}:${item.request_id}`;
    case "task_question":
      return `task_question:${item.task_id}:${item.request_id}`;
    case "chat_question":
      return `chat_question:${item.chat_id}:${item.request_id}`;
  }
}
