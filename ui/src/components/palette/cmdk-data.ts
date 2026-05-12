import {
  LayoutDashboard,
  Inbox,
  Layers,
  FolderGit2,
  MessageSquare,
  ListTodo,
  Clock,
  FileText,
  Wand2,
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "@/lib/types/project";
import type { Workspace } from "@/lib/types/workspace";
import type { ChatResponse } from "@/lib/types/chat";
import type { Task } from "@/lib/types/task";

/**
 * Discriminated row union for the ⌘K palette result list. Two
 * categories ship in slice 00:
 *   - `nav` — static destinations (every top-level route from the
 *             sidebar). Always present, never depend on a query.
 *   - `entity` — projects/workspaces/chats/tasks. Built from the
 *                React Query caches the page already populates.
 *
 * The `score()` helper assigns each row a relevance number against
 * a search query. Higher = more relevant. The renderer sorts within
 * each group; ties keep insertion order.
 */

export type CmdkRow =
  | {
      kind: "nav";
      id: string;
      label: string;
      hint?: string;
      to: string;
      icon: LucideIcon;
    }
  | {
      kind: "entity";
      group: "Projects" | "Workspaces" | "Chats" | "Tasks";
      id: string;
      label: string;
      hint?: string;
      to: string;
      icon: LucideIcon;
    };

export const NAV_ROWS: ReadonlyArray<CmdkRow> = [
  { kind: "nav", id: "nav:dashboard", label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, hint: "Overview" },
  { kind: "nav", id: "nav:attention", label: "Inbox", to: "/attention", icon: Inbox, hint: "Attention items" },
  { kind: "nav", id: "nav:workspaces", label: "Workspaces", to: "/workspaces", icon: Layers },
  { kind: "nav", id: "nav:projects", label: "Projects", to: "/projects", icon: FolderGit2 },
  { kind: "nav", id: "nav:chats", label: "Chats", to: "/chats", icon: MessageSquare },
  { kind: "nav", id: "nav:tasks", label: "Tasks", to: "/tasks", icon: ListTodo },
  { kind: "nav", id: "nav:schedules", label: "Schedules", to: "/schedules", icon: Clock },
  { kind: "nav", id: "nav:templates", label: "Templates", to: "/templates", icon: FileText },
  { kind: "nav", id: "nav:skills-mcp", label: "Skills & MCP", to: "/skills-mcp", icon: Wand2 },
  { kind: "nav", id: "nav:analytics", label: "Analytics", to: "/analytics", icon: BarChart3 },
  { kind: "nav", id: "nav:settings", label: "Settings", to: "/settings", icon: Settings },
];

/**
 * Cheap subsequence-tolerant matcher. Returns 0 when the haystack
 * does not contain every char of the needle in order; positive
 * otherwise (higher = tighter / earlier match). Case-insensitive.
 *
 * The metric is intentionally simple — VS Code-style fuzzy scoring
 * would justify pulling in a library, but for a palette over <500
 * rows the difference is invisible.
 */
export function score(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 800;
  if (h.includes(n)) return 600;
  // Subsequence — every char in order, anywhere.
  let i = 0;
  let matched = 0;
  let lastIdx = -1;
  let bonus = 0;
  for (const ch of n) {
    const idx = h.indexOf(ch, i);
    if (idx === -1) return 0;
    matched++;
    if (lastIdx !== -1 && idx === lastIdx + 1) bonus += 5; // adjacency bonus
    lastIdx = idx;
    i = idx + 1;
  }
  return matched > 0 ? 100 + bonus : 0;
}

export function entitiesToRows(opts: {
  projects: Project[] | undefined;
  workspaces: Workspace[] | undefined;
  chats: ChatResponse[] | undefined;
  tasks: Task[] | undefined;
}): CmdkRow[] {
  const out: CmdkRow[] = [];
  for (const p of opts.projects ?? []) {
    out.push({
      kind: "entity",
      group: "Projects",
      id: `project:${p.id}`,
      label: p.name,
      to: `/projects/${p.id}`,
      icon: FolderGit2,
    });
  }
  for (const w of opts.workspaces ?? []) {
    out.push({
      kind: "entity",
      group: "Workspaces",
      id: `workspace:${w.id}`,
      label: w.name,
      to: `/workspaces/${w.id}`,
      icon: Layers,
    });
  }
  for (const c of opts.chats ?? []) {
    const label = c.title ?? `Chat ${c.id.slice(0, 7)}`;
    out.push({
      kind: "entity",
      group: "Chats",
      id: `chat:${c.id}`,
      label,
      hint: c.project_name ?? c.workspace_name ?? undefined,
      to: `/chats/${c.id}`,
      icon: MessageSquare,
    });
  }
  for (const t of opts.tasks ?? []) {
    const promptLine = (t.prompt ?? "").split(/\r?\n/)[0] ?? "";
    const label = promptLine ? promptLine.slice(0, 60) : `Task ${t.id.slice(0, 7)}`;
    out.push({
      kind: "entity",
      group: "Tasks",
      id: `task:${t.id}`,
      label,
      hint: t.status,
      to: `/tasks/${t.id}`,
      icon: ListTodo,
    });
  }
  return out;
}

export function rankRows(rows: CmdkRow[], query: string): CmdkRow[] {
  if (!query.trim()) {
    // Empty query: nav rows on top, entities limited to first 20 to
    // avoid dumping a 1000-row dropdown in the user's face.
    const nav = rows.filter(r => r.kind === "nav");
    const entities = rows.filter(r => r.kind === "entity").slice(0, 20);
    return [...nav, ...entities];
  }
  const q = query.trim();
  return rows
    .map(r => ({ r, s: score(`${r.label} ${("hint" in r && r.hint) || ""}`, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.r);
}
