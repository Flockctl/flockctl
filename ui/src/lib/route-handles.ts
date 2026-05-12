import type { BreadcrumbHandleFn, BreadcrumbSegment } from "@/components/shell/Breadcrumb";
import { queryKeys } from "@/lib/hooks/core";
import type { Project } from "@/lib/types/project";
import type { Workspace } from "@/lib/types/workspace";
import type { Task } from "@/lib/types/task";
import type { ChatResponse } from "@/lib/types/chat";
import type { IncidentResponse } from "@/lib/api/incidents";
import type { Mission } from "@/lib/hooks/missions";
import { missionQueryKeys } from "@/lib/hooks/missions";

/**
 * Per-route `handle.breadcrumb` factories used by the new shell's
 * `<Breadcrumb />`. Each factory returns either:
 *   - a single segment ({ label, href? })
 *   - an array of segments (for routes that contribute multiple
 *     levels — e.g. project-detail emits both "Projects" and the
 *     project's own name)
 *   - null (the route does not appear in the trail)
 *
 * Parametric routes look up the entity name in the React Query
 * cache via the passed `qc`. On cache miss they emit a skeleton
 * placeholder (`loading: true`) so the trail's geometry is stable —
 * the React Query refetch driven by the page itself will populate
 * the cache and re-render the breadcrumb with the real label.
 *
 * Keep these handles `static` (no closure over component scope) and
 * cheap — they run on every navigation tick.
 */

// Typed-as-tuple consts so `STATIC.dashboard` etc. resolve to a
// concrete `BreadcrumbSegment` (not `BreadcrumbSegment | undefined`).
const dashboardSeg: BreadcrumbSegment = { label: "Dashboard", href: "/dashboard" };
const attentionSeg: BreadcrumbSegment = { label: "Inbox", href: "/attention" };
const workspacesSeg: BreadcrumbSegment = { label: "Workspaces", href: "/workspaces" };
const projectsSeg: BreadcrumbSegment = { label: "Projects", href: "/projects" };
const chatsSeg: BreadcrumbSegment = { label: "Chats", href: "/chats" };
const tasksSeg: BreadcrumbSegment = { label: "Tasks", href: "/tasks" };
const schedulesSeg: BreadcrumbSegment = { label: "Schedules", href: "/schedules" };
const templatesSeg: BreadcrumbSegment = { label: "Templates", href: "/templates" };
const skillsMcpSeg: BreadcrumbSegment = { label: "Skills & MCP", href: "/skills-mcp" };
const analyticsSeg: BreadcrumbSegment = { label: "Analytics", href: "/analytics" };
const settingsSeg: BreadcrumbSegment = { label: "Settings", href: "/settings" };
const incidentsSeg: BreadcrumbSegment = { label: "Incidents", href: "/incidents" };

export const dashboardHandle: BreadcrumbHandleFn = () => dashboardSeg;
export const attentionHandle: BreadcrumbHandleFn = () => attentionSeg;
export const workspacesHandle: BreadcrumbHandleFn = () => workspacesSeg;
export const projectsHandle: BreadcrumbHandleFn = () => projectsSeg;
export const chatsHandle: BreadcrumbHandleFn = () => chatsSeg;
export const tasksHandle: BreadcrumbHandleFn = () => tasksSeg;
export const schedulesHandle: BreadcrumbHandleFn = () => schedulesSeg;
export const templatesHandle: BreadcrumbHandleFn = () => templatesSeg;
export const skillsMcpHandle: BreadcrumbHandleFn = () => skillsMcpSeg;
export const analyticsHandle: BreadcrumbHandleFn = () => analyticsSeg;
export const settingsHandle: BreadcrumbHandleFn = () => settingsSeg;
export const incidentsHandle: BreadcrumbHandleFn = () => incidentsSeg;

export const projectDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.projectId;
  if (!id) return projectsSeg;
  const project = qc.getQueryData<Project>(queryKeys.project(id));
  return [
    projectsSeg,
    project?.name
      ? { label: project.name, href: `/projects/${id}` }
      : { label: "", loading: true, href: `/projects/${id}` },
  ];
};

export const projectCommitDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.projectId;
  const sha = params.sha?.slice(0, 7) ?? "";
  if (!id) return null;
  const project = qc.getQueryData<Project>(queryKeys.project(id));
  return [
    projectsSeg,
    project?.name
      ? { label: project.name, href: `/projects/${id}` }
      : { label: "", loading: true, href: `/projects/${id}` },
    { label: `Commit ${sha}` },
  ];
};

export const workspaceDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.workspaceId;
  if (!id) return workspacesSeg;
  const ws = qc.getQueryData<Workspace>(queryKeys.workspace(id));
  return [
    workspacesSeg,
    ws?.name
      ? { label: ws.name, href: `/workspaces/${id}` }
      : { label: "", loading: true, href: `/workspaces/${id}` },
  ];
};

export const workspaceCommitDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.workspaceId;
  const sha = params.sha?.slice(0, 7) ?? "";
  if (!id) return null;
  const ws = qc.getQueryData<Workspace>(queryKeys.workspace(id));
  return [
    workspacesSeg,
    ws?.name
      ? { label: ws.name, href: `/workspaces/${id}` }
      : { label: "", loading: true, href: `/workspaces/${id}` },
    { label: `Commit ${sha}` },
  ];
};

export const taskDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.taskId;
  if (!id) return tasksSeg;
  const task = qc.getQueryData<Task>(queryKeys.task(id));
  // Tasks have no human title — pull the first line of the prompt
  // (truncated) so the breadcrumb is at least informative. Falls back
  // to a short id-suffix when the cache is cold.
  const promptLine =
    typeof task?.prompt === "string" && task.prompt.length > 0
      ? (task.prompt.split(/\r?\n/)[0] ?? "").slice(0, 60)
      : null;
  const shortId = id.length > 7 ? `Task ${id.slice(0, 7)}` : `Task ${id}`;
  return [
    tasksSeg,
    promptLine
      ? { label: promptLine, href: `/tasks/${id}` }
      : task
      ? { label: shortId, href: `/tasks/${id}` }
      : { label: "", loading: true, href: `/tasks/${id}` },
  ];
};

export const chatDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.chatId;
  if (!id) return chatsSeg;
  const chat = qc.getQueryData<ChatResponse>(queryKeys.chat(id));
  // Chat titles are user-supplied and frequently null (untitled chats
  // never get auto-renamed). Render a deterministic fallback in that
  // case — the previous skeleton placeholder stuck around forever for
  // any chat without a title and looked like a stuck loading spinner.
  const title = chat?.title?.trim() || null;
  const fallback = chat
    ? "Untitled chat"
    : `Chat ${id.slice(0, 7)}`;
  return [
    chatsSeg,
    { label: title ?? fallback, href: `/chats/${id}` },
  ];
};

export const missionDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.missionId;
  if (!id) return null;
  const mission = qc.getQueryData<Mission>(missionQueryKeys.byId(id));
  // Mission objective is an opaque user string — it's the closest
  // thing to a name. Truncate so the breadcrumb stays one line.
  const label =
    typeof mission?.objective === "string" && mission.objective.length > 0
      ? mission.objective.slice(0, 60)
      : null;
  return [
    { label: "Missions" },
    label
      ? { label, href: `/missions/${id}` }
      : { label: "", loading: true, href: `/missions/${id}` },
  ];
};

export const incidentDetailHandle: BreadcrumbHandleFn = ({ params, qc }) => {
  const id = params.id;
  if (!id) return null;
  const inc = qc.getQueryData<IncidentResponse>(queryKeys.incident(id));
  // Incidents always have a `title` field; fall back to a short id
  // placeholder when the cache is cold so the trail's geometry is
  // stable across the first render.
  const label = inc?.title ?? null;
  return [
    incidentsSeg,
    label
      ? { label, href: `/incidents/${id}` }
      : { label: "", loading: true, href: `/incidents/${id}` },
  ];
};
