import { memo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  approveChat,
  approveTask,
  rejectChat,
  rejectTask,
  respondToPermission,
  respondToChatPermission,
  type AttentionItem,
} from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks";
import { getActiveServerId } from "@/lib/server-store";
import type { Project } from "@/lib/types";

/**
 * Inbox row — a single actionable blocker with inline allow/deny buttons.
 *
 * Visual language is borrowed from the permission-request cards on the task
 * detail page (`ui/src/pages/task-detail.tsx` ~L349–L415) so a user sees the
 * same shape whether they're on the task page or the global inbox. The inbox
 * variant is intentionally simpler:
 *   - no "Allow always" scope picker (inbox is list-scale, picker belongs on
 *     the detail page where the extra context is visible)
 *   - no raw tool_input dump (attention items never include it — args can
 *     carry secrets, the backend strips them at aggregation time)
 *   - tighter row height so many rows can fit on screen at once
 *
 * Each kind (`task_approval`, `chat_approval`, `task_permission`,
 * `chat_permission`) owns its own component with its own deep-link + action
 * handlers, and `AttentionRow` just discriminates on `item.kind`. The
 * optimistic removal is local to each sub-component — after the API call
 * returns we invalidate the `attention` query so the server-side
 * `attention_changed` broadcast reconciles any transient mismatch.
 */

interface AttentionRowProps {
  item: AttentionItem;
  projectsById: Map<string, Project>;
}

export const AttentionRow = memo(function AttentionRow({ item, projectsById }: AttentionRowProps) {
  switch (item.kind) {
    case "task_approval":
      return <TaskApprovalRow item={item} projectsById={projectsById} />;
    case "chat_approval":
      return <ChatApprovalRow item={item} projectsById={projectsById} />;
    case "task_permission":
      return <TaskPermissionRow item={item} projectsById={projectsById} />;
    case "chat_permission":
      return <ChatPermissionRow item={item} projectsById={projectsById} />;
  }
});

/* --- Sub-components ------------------------------------------------------ */

function TaskApprovalRow({
  item,
  projectsById,
}: {
  item: Extract<AttentionItem, { kind: "task_approval" }>;
  projectsById: Map<string, Project>;
}) {
  const invalidateAttention = useInvalidateAttention();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const projectName = resolveProjectName(item.project_id, projectsById);
  const title = item.title?.trim() ? item.title : `Task #${item.task_id}`;

  async function onAllow() {
    setBusy("approve");
    try {
      await approveTask(item.task_id);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to approve task", err);
    } finally {
      invalidateAttention();
    }
  }
  async function onDeny() {
    setBusy("reject");
    try {
      await rejectTask(item.task_id);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to reject task", err);
    } finally {
      invalidateAttention();
    }
  }

  return (
    <RowShell
      projectName={projectName}
      kindBadge="Task approval"
      detail="awaiting approval"
      since={item.since}
      linkTo={`/tasks/${item.task_id}`}
      title={title}
      actions={
        <>
          <Button size="sm" disabled={busy !== null} onClick={onAllow}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={onDeny}
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </>
      }
    />
  );
}

function ChatApprovalRow({
  item,
  projectsById,
}: {
  item: Extract<AttentionItem, { kind: "chat_approval" }>;
  projectsById: Map<string, Project>;
}) {
  const invalidateAttention = useInvalidateAttention();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const projectName = resolveProjectName(item.project_id, projectsById);
  const title = item.title?.trim() ? item.title : `Chat #${item.chat_id}`;

  async function onAllow() {
    setBusy("approve");
    try {
      await approveChat(item.chat_id);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to approve chat", err);
    } finally {
      invalidateAttention();
    }
  }
  async function onDeny() {
    setBusy("reject");
    try {
      await rejectChat(item.chat_id);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to reject chat", err);
    } finally {
      invalidateAttention();
    }
  }

  return (
    <RowShell
      projectName={projectName}
      kindBadge="Chat approval"
      detail="awaiting approval"
      since={item.since}
      linkTo={`/chats/${item.chat_id}`}
      title={title}
      actions={
        <>
          <Button size="sm" disabled={busy !== null} onClick={onAllow}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={onDeny}
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </>
      }
    />
  );
}

function TaskPermissionRow({
  item,
  projectsById,
}: {
  item: Extract<AttentionItem, { kind: "task_permission" }>;
  projectsById: Map<string, Project>;
}) {
  const invalidateAttention = useInvalidateAttention();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const projectName = resolveProjectName(item.project_id, projectsById);

  async function respond(behavior: "allow" | "deny") {
    setBusy(behavior);
    try {
      await respondToPermission(item.task_id, item.request_id, behavior);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to respond to permission", err);
    } finally {
      invalidateAttention();
    }
  }

  return (
    <RowShell
      projectName={projectName}
      kindBadge="Tool permission"
      detail={item.tool}
      since={item.since}
      linkTo={`/tasks/${item.task_id}`}
      title={`Task #${item.task_id}`}
      actions={
        <>
          <Button size="sm" disabled={busy !== null} onClick={() => respond("allow")}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => respond("deny")}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
        </>
      }
    />
  );
}

function ChatPermissionRow({
  item,
  projectsById,
}: {
  item: Extract<AttentionItem, { kind: "chat_permission" }>;
  projectsById: Map<string, Project>;
}) {
  const invalidateAttention = useInvalidateAttention();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const projectName = resolveProjectName(item.project_id, projectsById);

  async function respond(behavior: "allow" | "deny") {
    setBusy(behavior);
    try {
      await respondToChatPermission(item.chat_id, item.request_id, behavior);
      setHidden(true);
    } catch (err) {
      setBusy(null);
      console.error("Failed to respond to chat permission", err);
    } finally {
      invalidateAttention();
    }
  }

  return (
    <RowShell
      projectName={projectName}
      kindBadge="Chat permission"
      detail={item.tool}
      since={item.since}
      linkTo={`/chats/${item.chat_id}`}
      title={`Chat #${item.chat_id}`}
      actions={
        <>
          <Button size="sm" disabled={busy !== null} onClick={() => respond("allow")}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => respond("deny")}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
        </>
      }
    />
  );
}

/* --- Shared shell -------------------------------------------------------- */

/**
 * Consistent layout for every inbox row. Kept as a private helper rather than
 * an exported component — other pages should not render inbox rows without
 * going through `AttentionRow` (which discriminates on kind).
 */
function RowShell({
  projectName,
  kindBadge,
  detail,
  since,
  linkTo,
  title,
  actions,
}: {
  projectName: string | null;
  kindBadge: string;
  detail: string;
  since: string;
  linkTo: string;
  title: string;
  actions: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <Link to={linkTo} className="min-w-0 flex-1 group">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">{kindBadge}</Badge>
            {projectName && (
              <span className="truncate text-xs text-muted-foreground">
                {projectName}
              </span>
            )}
          </div>
          <p className="truncate text-sm font-medium group-hover:underline">
            {title}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={since}
          >
            {formatRelativeTime(since)}
          </time>
          {actions}
        </div>
      </CardContent>
    </Card>
  );
}

/* --- Helpers ------------------------------------------------------------- */

function resolveProjectName(
  projectId: string | null,
  projectsById: Map<string, Project>,
): string | null {
  if (!projectId) return null;
  const p = projectsById.get(projectId);
  return p?.name ?? `Project #${projectId}`;
}

/**
 * "2m ago" / "3h ago" formatter.
 *
 * We deliberately avoid `Intl.RelativeTimeFormat` here because it insists on
 * localised wordier strings ("2 minutes ago"), which breaks the tight inbox
 * layout. A handful of integer comparisons is cheaper than a `new Intl.*`
 * allocation per render and keeps output stable for snapshot tests.
 */
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Shared invalidation hook — after any allow/deny we nudge React Query to
 * re-fetch the inbox so the optimistic removal stays in sync with the
 * ground truth (the server will also broadcast `attention_changed`, but
 * we don't want to depend on that round-trip for responsiveness).
 */
function useInvalidateAttention() {
  const queryClient = useQueryClient();
  return () => {
    const serverId = getActiveServerId();
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(serverId) });
  };
}
