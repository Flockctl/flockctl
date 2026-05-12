import * as React from "react";
import { Plus } from "lucide-react";

import {
  useGlobalSkills,
  useWorkspaceSkills,
  useProjectSkills,
  useGlobalMcpServers,
  useWorkspaceMcpServers,
  useProjectMcpServers,
  useWorkspaces,
  useProjects,
} from "@/lib/hooks";
import type { Skill, McpServer } from "@/lib/types";
import { SectionHeader } from "@/components/design";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { SkillsPane } from "./skills-mcp-components/SkillsPane";
import { McpPane } from "./skills-mcp-components/McpPane";
import type {
  SkillRowData,
  SkillScope,
} from "./skills-mcp-components/SkillRow";
import { SkillDialog } from "@/components/skills-mcp/SkillDialog";
import { McpServerDialog } from "@/components/skills-mcp/McpServerDialog";

/**
 * `/skills-mcp` page — the redesigned two-pane "library" surface
 * (slice `25-ui-redesign-library-surfaces/01-skills-mcp` T03).
 *
 * Top-down composition:
 *
 *   SectionHeader (size="page", title="Skills & MCP", subtitle=count)
 *   ────────────────────────────────────────────────────────────────
 *   Workspace + Project scope selectors (drive `useWorkspaceSkills`
 *     / `useProjectSkills` and the matching MCP hooks).
 *   ────────────────────────────────────────────────────────────────
 *   div.grid.grid-cols-2.gap-4
 *     <SkillsPane …>   ← left half
 *     <McpPane …>      ← right half
 *
 * Each pane owns its own loading / error / empty branch — a failure
 * to load skills must NOT blank the MCP pane and vice versa. That's
 * the slice's "independent error states per pane" requirement.
 *
 * Click flows preserved from the legacy `SkillsTab` / `McpTab`:
 *   - Click an editable (workspace / project) skill row → opens
 *     `SkillDialog` in edit mode.
 *   - Click an MCP row → opens `McpServerDialog` in edit mode.
 *   - Header `+ Add` actions on each pane open the matching dialog
 *     in create mode, scoped to the deepest selector that has a
 *     value (project ▶ workspace ▶ global).
 */

const LEVEL_TO_SCOPE: Record<"global" | "workspace" | "project", SkillScope> = {
  global: "system",
  workspace: "user",
  project: "project",
};

/**
 * Derive a short, deterministic tag list from the skill name. The
 * legacy `Skill` row carries no tags column (only `name`, `level`,
 * `content`), but the redesigned `SkillRow` design wants a tag chip
 * row so the library reads like the prototype. Splitting the slug
 * on `-` / `_` / `/` is the cheapest reasonable derivation that
 * doesn't require parsing the whole markdown body.
 */
function deriveTags(name: string): string[] {
  return name
    .split(/[-_/]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * First non-blank, non-heading line of the skill content — used as
 * the row description. Falls back to `null` when the skill body is
 * empty or contains only headings.
 */
function deriveDescription(content: string): string | null {
  const lines = (content ?? "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return null;
}

function skillToRow(skill: Skill): SkillRowData {
  return {
    key: `${skill.level}:${skill.name}`,
    name: skill.name,
    description: deriveDescription(skill.content ?? ""),
    scope: LEVEL_TO_SCOPE[skill.level],
    tags: deriveTags(skill.name),
  };
}

export default function SkillsMcpPage(): React.JSX.Element {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState("");
  const [selectedProjectId, setSelectedProjectId] = React.useState("");

  const workspacesQ = useWorkspaces();
  const projectsQ = useProjects();
  const workspacesList = workspacesQ.data ?? [];
  const projectsList = projectsQ.data ?? [];
  const filteredProjects = selectedWorkspaceId
    ? projectsList.filter(
        (p) => String(p.workspace_id) === selectedWorkspaceId,
      )
    : projectsList;

  // ── Skills: parallel queries, merged. Each pane handles its own
  //    loading / error branch independently of the other.
  const globalSkillsQ = useGlobalSkills();
  const wsSkillsQ = useWorkspaceSkills(selectedWorkspaceId);
  const projSkillsQ = useProjectSkills(selectedWorkspaceId, selectedProjectId);

  // ── MCP servers: same trio.
  const globalMcpQ = useGlobalMcpServers();
  const wsMcpQ = useWorkspaceMcpServers(selectedWorkspaceId);
  const projMcpQ = useProjectMcpServers(selectedWorkspaceId, selectedProjectId);

  const allSkills = React.useMemo<Skill[]>(() => {
    const items: Skill[] = [];
    if (globalSkillsQ.data) items.push(...globalSkillsQ.data);
    if (wsSkillsQ.data) items.push(...wsSkillsQ.data);
    if (projSkillsQ.data) items.push(...projSkillsQ.data);
    return items;
  }, [globalSkillsQ.data, wsSkillsQ.data, projSkillsQ.data]);

  const skillRows = React.useMemo<SkillRowData[]>(
    () => allSkills.map(skillToRow),
    [allSkills],
  );

  const allServers = React.useMemo<McpServer[]>(() => {
    const items: McpServer[] = [];
    if (globalMcpQ.data) items.push(...globalMcpQ.data);
    if (wsMcpQ.data) items.push(...wsMcpQ.data);
    if (projMcpQ.data) items.push(...projMcpQ.data);
    return items;
  }, [globalMcpQ.data, wsMcpQ.data, projMcpQ.data]);

  // ── Dialog state — one for each entity. Keep them strictly
  //    separate so an open skill dialog can't trample the MCP one.
  const [skillDialogOpen, setSkillDialogOpen] = React.useState(false);
  const [skillDialogScope, setSkillDialogScope] = React.useState<
    "global" | "workspace" | "project"
  >("global");
  const [editSkill, setEditSkill] = React.useState<Skill | null>(null);

  const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false);
  const [mcpDialogScope, setMcpDialogScope] = React.useState<
    "global" | "workspace" | "project"
  >("global");
  const [editServer, setEditServer] = React.useState<McpServer | null>(null);

  // ── Independent pane states. We treat the *global* query as the
  //    source of truth for the load/error branch, because it always
  //    runs (workspace/project queries are gated by selector value).
  //    A workspace-level fetch failure flips the pane into the error
  //    branch too — but the other pane is unaffected.
  const skillsLoading = globalSkillsQ.isLoading;
  const skillsError =
    globalSkillsQ.error ?? wsSkillsQ.error ?? projSkillsQ.error ?? null;
  const mcpLoading = globalMcpQ.isLoading;
  const mcpError = globalMcpQ.error ?? wsMcpQ.error ?? projMcpQ.error ?? null;

  function handleSkillClick(row: SkillRowData) {
    const found = allSkills.find(
      (s) => `${s.level}:${s.name}` === row.key,
    );
    if (!found) return;
    // Global skills are read-only here — opening the dialog would
    // surface an editable form against an immutable source. Match
    // the legacy SkillsTab gate.
    if (found.level === "global") return;
    setEditSkill(found);
    setSkillDialogScope(found.level);
    setSkillDialogOpen(true);
  }

  function pickDeepestScope(): "global" | "workspace" | "project" {
    if (selectedProjectId) return "project";
    if (selectedWorkspaceId) return "workspace";
    return "global";
  }

  function handleAddSkill() {
    setEditSkill(null);
    setSkillDialogScope(pickDeepestScope());
    setSkillDialogOpen(true);
  }

  function handleAddMcp() {
    setEditServer(null);
    setMcpDialogScope(pickDeepestScope());
    setMcpDialogOpen(true);
  }

  function handleSelectMcp(server: McpServer) {
    setEditServer(server);
    setMcpDialogScope(server.level);
    setMcpDialogOpen(true);
  }

  function handleWorkspaceChange(val: string) {
    setSelectedWorkspaceId(val === "__none" ? "" : val);
    setSelectedProjectId("");
  }

  function handleProjectChange(val: string) {
    setSelectedProjectId(val === "__none" ? "" : val);
    if (val && val !== "__none") {
      const proj = projectsList.find((p) => p.id === val);
      if (proj?.workspace_id && !selectedWorkspaceId) {
        setSelectedWorkspaceId(String(proj.workspace_id));
      }
    }
  }

  return (
    <div className="space-y-4 max-w-7xl" data-testid="skills-mcp-page">
      <SectionHeader
        size="page"
        title="Skills & MCP"
        subtitle={`${skillRows.length} skill${skillRows.length === 1 ? "" : "s"} · ${allServers.length} MCP server${allServers.length === 1 ? "" : "s"}`}
        data-testid="skills-mcp-page-header"
      />

      {/* Scope selectors */}
      <div
        className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4"
        data-testid="skills-mcp-scope-selectors"
      >
        <div className="space-y-1.5">
          <Label className="text-xs">Workspace</Label>
          <Select
            value={selectedWorkspaceId || "__none"}
            onValueChange={handleWorkspaceChange}
          >
            <SelectTrigger
              className="w-48"
              data-testid="skills-mcp-workspace-select"
            >
              <SelectValue placeholder="All / Global only" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">All / Global only</SelectItem>
              {workspacesList.map((ws) => (
                <SelectItem key={ws.id} value={ws.id}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Project</Label>
          <Select
            value={selectedProjectId || "__none"}
            onValueChange={handleProjectChange}
          >
            <SelectTrigger
              className="w-48"
              data-testid="skills-mcp-project-select"
            >
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">None</SelectItem>
              {filteredProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Two-pane grid: SkillsPane | McpPane. Stack on narrow viewports
          so the layout doesn't blow out a phone screen. */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-4"
        data-testid="skills-mcp-grid"
      >
        {/* Skills column */}
        <section data-testid="skills-mcp-skills-column">
          {skillsLoading ? (
            <div
              data-testid="skills-pane-loading"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : skillsError ? (
            <div
              data-testid="skills-pane-error"
              className="text-[12px] text-destructive py-4 text-center border border-dashed border-destructive/40 rounded"
              role="alert"
            >
              Failed to load skills.
            </div>
          ) : (
            <SkillsPane
              skills={skillRows}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="skills-pane-add-button"
                  onClick={handleAddSkill}
                  className="h-7 px-2 text-[11.5px]"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Add skill
                </Button>
              }
              onSkillClick={handleSkillClick}
            />
          )}
        </section>

        {/* MCP column */}
        <section data-testid="skills-mcp-mcp-column">
          {mcpLoading ? (
            <div
              data-testid="mcp-pane-loading"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : mcpError ? (
            <div
              data-testid="mcp-pane-error"
              className="text-[12px] text-destructive py-4 text-center border border-dashed border-destructive/40 rounded"
              role="alert"
            >
              Failed to load MCP servers.
            </div>
          ) : (
            <McpPane
              servers={allServers}
              onAdd={handleAddMcp}
              onSelect={handleSelectMcp}
            />
          )}
        </section>
      </div>

      <SkillDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        scope={skillDialogScope}
        workspaceId={selectedWorkspaceId}
        projectId={selectedProjectId}
        editSkill={editSkill}
      />
      <McpServerDialog
        open={mcpDialogOpen}
        onOpenChange={setMcpDialogOpen}
        scope={mcpDialogScope}
        workspaceId={selectedWorkspaceId}
        projectId={selectedProjectId}
        editServer={editServer}
      />
    </div>
  );
}
