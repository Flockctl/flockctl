import { useState, useMemo } from "react";
import {
  useGlobalSkills,
  useWorkspaceSkills,
  useProjectSkills,
  useGlobalMcpServers,
  useWorkspaceMcpServers,
  useProjectMcpServers,
  useWorkspaces,
  useProjects,
  useCreateGlobalSkill,
  useCreateWorkspaceSkill,
  useCreateProjectSkill,
  useDeleteWorkspaceSkill,
  useDeleteProjectSkill,
  useCreateGlobalMcpServer,
  useCreateWorkspaceMcpServer,
  useCreateProjectMcpServer,
  useDeleteGlobalMcpServer,
  useDeleteWorkspaceMcpServer,
  useDeleteProjectMcpServer,
  useWorkspaceDisabledSkills,
  useToggleWorkspaceDisabledSkill,
  useProjectDisabledSkills,
  useToggleProjectDisabledSkill,
  useWorkspaceDisabledMcpServers,
  useToggleWorkspaceDisabledMcpServer,
  useProjectDisabledMcpServers,
  useToggleProjectDisabledMcpServer,
} from "@/lib/hooks";
import type { Skill, McpServer, McpServerConfig } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Wand2, Server, Plus, Trash2, Pencil, ChevronDown, ChevronRight, EyeOff, Eye } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

type Tab = "skills" | "mcp";

const levelColors: Record<string, string> = {
  global: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  workspace: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  project: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
};

function SkillContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;

  return (
    <div className="mt-1">
      <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-60 overflow-auto rounded bg-muted p-2">
        {expanded ? content : preview}
      </pre>
      {content.length > 200 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {expanded ? "Collapse" : "Show full content"}
        </button>
      )}
    </div>
  );
}

function McpConfigView({ config }: { config: McpServerConfig }) {
  return (
    <div className="mt-1 space-y-1 text-xs text-muted-foreground">
      <div>
        <span className="font-medium">command:</span>{" "}
        <code className="rounded bg-muted px-1 py-0.5">{config.command}</code>
      </div>
      {config.args && config.args.length > 0 && (
        <div>
          <span className="font-medium">args:</span>{" "}
          <code className="rounded bg-muted px-1 py-0.5">{config.args.join(" ")}</code>
        </div>
      )}
      {config.env && Object.keys(config.env).length > 0 && (
        <div>
          <span className="font-medium">env:</span>{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            {Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join(", ")}
          </code>
        </div>
      )}
    </div>
  );
}

// --- Create Skill Dialog ---

function SkillDialog({
  open,
  onOpenChange,
  scope,
  workspaceId,
  projectId,
  editSkill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "workspace" | "project";
  workspaceId: string;
  projectId: string;
  editSkill?: Skill | null;
}) {
  const createGlobal = useCreateGlobalSkill();
  const createWorkspace = useCreateWorkspaceSkill(workspaceId);
  const createProject = useCreateProjectSkill(workspaceId, projectId);

  const [name, setName] = useState(editSkill?.name ?? "");
  const [content, setContent] = useState(editSkill?.content ?? "");
  const [error, setError] = useState("");

  const [prevEdit, setPrevEdit] = useState<Skill | null | undefined>(undefined);
  if (editSkill !== prevEdit) {
    setPrevEdit(editSkill);
    setName(editSkill?.name ?? "");
    setContent(editSkill?.content ?? "");
    setError("");
  }

  function reset() {
    setName("");
    setContent("");
    setError("");
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required");
      return;
    }
    setError("");
    try {
      const data = { name: name.trim(), content: content.trim() };
      if (scope === "global") await createGlobal.mutateAsync(data);
      else if (scope === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createGlobal.isPending || createWorkspace.isPending || createProject.isPending;
  const isEditing = !!editSkill;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Skill" : `Add Skill (${scope})`}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Edit the "${editSkill.name}" skill at ${scope} level.`
              : `Create a new SKILL.md at the ${scope} level.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              placeholder="e.g. api-design"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEditing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-content">Content (Markdown)</Label>
            <Textarea
              id="skill-content"
              placeholder={"# Skill Name\n\nDescription and instructions..."}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[200px] font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Create MCP Dialog ---

function CreateMcpDialog({
  open,
  onOpenChange,
  scope,
  workspaceId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "workspace" | "project";
  workspaceId: string;
  projectId: string;
}) {
  const createGlobal = useCreateGlobalMcpServer();
  const createWorkspace = useCreateWorkspaceMcpServer(workspaceId);
  const createProject = useCreateProjectMcpServer(workspaceId, projectId);

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envVars, setEnvVars] = useState("");
  const [error, setError] = useState("");

  function reset() {
    setName("");
    setCommand("");
    setArgs("");
    setEnvVars("");
    setError("");
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    if (!name.trim() || !command.trim()) {
      setError("Name and command are required");
      return;
    }
    setError("");
    try {
      const config: McpServerConfig = { command: command.trim() };
      if (args.trim()) config.args = args.split(/\s+/).filter(Boolean);
      if (envVars.trim()) {
        config.env = {};
        for (const line of envVars.split("\n")) {
          const eqIdx = line.indexOf("=");
          if (eqIdx > 0) config.env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
      const data = { name: name.trim(), config };
      if (scope === "global") await createGlobal.mutateAsync(data);
      else if (scope === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createGlobal.isPending || createWorkspace.isPending || createProject.isPending;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add MCP Server ({scope})</DialogTitle>
          <DialogDescription>
            Configure a new MCP server at the {scope} level.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              placeholder="e.g. github"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              placeholder="e.g. npx"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-args">Arguments (space-separated)</Label>
            <Input
              id="mcp-args"
              placeholder="e.g. -y @modelcontextprotocol/server-github"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-env">Environment variables (KEY=VALUE, one per line)</Label>
            <Textarea
              id="mcp-env"
              placeholder="GITHUB_TOKEN=ghp_..."
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              className="min-h-[80px] font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Skills Tab ---

function SkillsTab({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const globalQ = useGlobalSkills();
  const wsQ = useWorkspaceSkills(workspaceId);
  const projQ = useProjectSkills(workspaceId, projectId);

  const deleteWs = useDeleteWorkspaceSkill(workspaceId);
  const deleteProj = useDeleteProjectSkill(workspaceId, projectId);

  const wsDisabledQ = useWorkspaceDisabledSkills(workspaceId);
  const projDisabledQ = useProjectDisabledSkills(projectId);
  const toggleWsDisabled = useToggleWorkspaceDisabledSkill(workspaceId);
  const toggleProjDisabled = useToggleProjectDisabledSkill(projectId);

  const wsDisabledSet = useMemo(
    () => new Set((wsDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [wsDisabledQ.data],
  );
  const projDisabledSet = useMemo(
    () => new Set((projDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [projDisabledQ.data],
  );

  const deleteConfirm = useConfirmDialog();
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogScope, setDialogScope] = useState<"global" | "workspace" | "project">("global");
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  const allSkills = useMemo(() => {
    const items: Skill[] = [];
    if (globalQ.data) items.push(...globalQ.data);
    if (wsQ.data) items.push(...wsQ.data);
    if (projQ.data) items.push(...projQ.data);
    return items;
  }, [globalQ.data, wsQ.data, projQ.data]);

  const isLoading = globalQ.isLoading;

  function handleDelete(skill: Skill) {
    setDeleteTarget(skill);
    deleteConfirm.requestConfirm(`${skill.level}:${skill.name}`);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut = deleteTarget.level === "workspace" ? deleteWs : deleteProj;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  function openCreate(scope: "global" | "workspace" | "project") {
    setEditSkill(null);
    setDialogScope(scope);
    setDialogOpen(true);
  }

  function openEdit(skill: Skill) {
    setEditSkill(skill);
    setDialogScope(skill.level as "global" | "workspace" | "project");
    setDialogOpen(true);
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openCreate("global")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Global
        </Button>
        {workspaceId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("workspace")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Workspace
          </Button>
        )}
        {projectId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("project")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Project
          </Button>
        )}
      </div>

      {allSkills.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No skills configured. Add a skill at any level to get started.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Level</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {allSkills.map((skill) => {
              const key = `${skill.level}:${skill.name}`;
              const isExpanded = expandedSkill === key;
              const canToggleWs = !!workspaceId && skill.level === "global";
              const canToggleProj = !!projectId && (skill.level === "global" || skill.level === "workspace");
              const disabledByWs = canToggleWs && wsDisabledSet.has(`${skill.level}:${skill.name}`);
              const disabledByProj = canToggleProj && projDisabledSet.has(`${skill.level}:${skill.name}`);
              const isDisabled = disabledByWs || disabledByProj;
              return (
                <>
                  <TableRow
                    key={key}
                    className={`cursor-pointer ${isDisabled ? "opacity-50" : ""}`}
                    onClick={() => setExpandedSkill(isExpanded ? null : key)}
                  >
                    <TableCell className="w-8">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className={`font-medium ${isDisabled ? "line-through" : ""}`}>
                      {skill.name}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary" className={levelColors[skill.level]}>
                          {skill.level}
                        </Badge>
                        {disabledByWs && (
                          <Badge variant="outline" className="text-xs">disabled by workspace</Badge>
                        )}
                        {disabledByProj && (
                          <Badge variant="outline" className="text-xs">disabled by project</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canToggleWs && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={disabledByWs ? "Enable at workspace" : "Disable at workspace"}
                            disabled={toggleWsDisabled.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleWsDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabledByWs });
                            }}
                          >
                            {disabledByWs ? (
                              <Eye className="h-3.5 w-3.5" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {canToggleProj && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={disabledByProj ? "Enable at project" : "Disable at project"}
                            disabled={toggleProjDisabled.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProjDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabledByProj });
                            }}
                          >
                            {disabledByProj ? (
                              <Eye className="h-3.5 w-3.5 text-purple-600" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5 text-purple-600" />
                            )}
                          </Button>
                        )}
                        {skill.level !== "global" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEdit(skill);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {skill.level !== "global" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(skill);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow key={`${key}-content`}>
                      <TableCell colSpan={4} className="p-3">
                        <SkillContent content={skill.content} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}

      <SkillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scope={dialogScope}
        workspaceId={workspaceId}
        projectId={projectId}
        editSkill={editSkill}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Skill"
        description={`Delete skill "${deleteTarget?.name}"? This cannot be undone.`}
        isPending={deleteWs.isPending || deleteProj.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

// --- MCP Tab ---

function McpTab({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const globalQ = useGlobalMcpServers();
  const wsQ = useWorkspaceMcpServers(workspaceId);
  const projQ = useProjectMcpServers(workspaceId, projectId);

  const deleteGlobal = useDeleteGlobalMcpServer();
  const deleteWs = useDeleteWorkspaceMcpServer(workspaceId);
  const deleteProj = useDeleteProjectMcpServer(workspaceId, projectId);

  const wsDisabledQ = useWorkspaceDisabledMcpServers(workspaceId);
  const projDisabledQ = useProjectDisabledMcpServers(projectId);
  const toggleWsDisabled = useToggleWorkspaceDisabledMcpServer(workspaceId);
  const toggleProjDisabled = useToggleProjectDisabledMcpServer(projectId);

  const wsDisabledSet = useMemo(
    () => new Set((wsDisabledQ.data?.disabled_mcp_servers ?? []).map((e) => `${e.level}:${e.name}`)),
    [wsDisabledQ.data],
  );
  const projDisabledSet = useMemo(
    () => new Set((projDisabledQ.data?.disabled_mcp_servers ?? []).map((e) => `${e.level}:${e.name}`)),
    [projDisabledQ.data],
  );

  const deleteConfirm = useConfirmDialog();
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createScope, setCreateScope] = useState<"global" | "workspace" | "project">("global");
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  const allServers = useMemo(() => {
    const items: McpServer[] = [];
    if (globalQ.data) items.push(...globalQ.data);
    if (wsQ.data) items.push(...wsQ.data);
    if (projQ.data) items.push(...projQ.data);
    return items;
  }, [globalQ.data, wsQ.data, projQ.data]);

  const isLoading = globalQ.isLoading;

  function handleDelete(server: McpServer) {
    setDeleteTarget(server);
    deleteConfirm.requestConfirm(`${server.level}:${server.name}`);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut =
      deleteTarget.level === "global" ? deleteGlobal :
      deleteTarget.level === "workspace" ? deleteWs : deleteProj;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  function openCreate(scope: "global" | "workspace" | "project") {
    setCreateScope(scope);
    setCreateOpen(true);
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openCreate("global")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Global
        </Button>
        {workspaceId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("workspace")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Workspace
          </Button>
        )}
        {projectId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("project")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Project
          </Button>
        )}
      </div>

      {allServers.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No MCP servers configured. Add a server at any level to get started.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>Command</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {allServers.map((server) => {
              const key = `${server.level}:${server.name}`;
              const isExpanded = expandedServer === key;
              const canToggleWs = !!workspaceId && server.level === "global";
              const canToggleProj = !!projectId && (server.level === "global" || server.level === "workspace");
              const disabledByWs = canToggleWs && wsDisabledSet.has(`${server.level}:${server.name}`);
              const disabledByProj = canToggleProj && projDisabledSet.has(`${server.level}:${server.name}`);
              const isDisabled = disabledByWs || disabledByProj;
              return (
                <>
                  <TableRow
                    key={key}
                    className={`cursor-pointer ${isDisabled ? "opacity-50" : ""}`}
                    onClick={() => setExpandedServer(isExpanded ? null : key)}
                  >
                    <TableCell className="w-8">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className={`font-medium ${isDisabled ? "line-through" : ""}`}>
                      {server.name}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary" className={levelColors[server.level]}>
                          {server.level}
                        </Badge>
                        {disabledByWs && (
                          <Badge variant="outline" className="text-xs">disabled by workspace</Badge>
                        )}
                        {disabledByProj && (
                          <Badge variant="outline" className="text-xs">disabled by project</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {server.config.command}
                        {server.config.args ? ` ${server.config.args.join(" ")}` : ""}
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canToggleWs && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={disabledByWs ? "Enable at workspace" : "Disable at workspace"}
                            disabled={toggleWsDisabled.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleWsDisabled.mutate({ name: server.name, level: server.level, disable: !disabledByWs });
                            }}
                          >
                            {disabledByWs ? (
                              <Eye className="h-3.5 w-3.5" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {canToggleProj && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={disabledByProj ? "Enable at project" : "Disable at project"}
                            disabled={toggleProjDisabled.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProjDisabled.mutate({ name: server.name, level: server.level, disable: !disabledByProj });
                            }}
                          >
                            {disabledByProj ? (
                              <Eye className="h-3.5 w-3.5 text-purple-600" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5 text-purple-600" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(server);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow key={`${key}-config`}>
                      <TableCell colSpan={5} className="p-3">
                        <McpConfigView config={server.config} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreateMcpDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        scope={createScope}
        workspaceId={workspaceId}
        projectId={projectId}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete MCP Server"
        description={`Delete MCP server "${deleteTarget?.name}"? This cannot be undone.`}
        isPending={deleteGlobal.isPending || deleteWs.isPending || deleteProj.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

// --- Main Page ---

export default function SkillsMcpPage() {
  const [tab, setTab] = useState<Tab>("skills");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");

  const workspacesQ = useWorkspaces();
  const projectsQ = useProjects();

  const workspacesList = workspacesQ.data ?? [];
  const projectsList = projectsQ.data ?? [];

  const filteredProjects = selectedWorkspaceId
    ? projectsList.filter((p) => String(p.workspace_id) === selectedWorkspaceId)
    : projectsList;

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Skills & MCP</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage skills and MCP servers across global, workspace, and project levels.
        </p>
      </div>

      {/* Scope selectors */}
      <div className="flex items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Workspace</Label>
          <Select value={selectedWorkspaceId || "__none"} onValueChange={handleWorkspaceChange}>
            <SelectTrigger className="w-48">
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
          <Select value={selectedProjectId || "__none"} onValueChange={handleProjectChange}>
            <SelectTrigger className="w-48">
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

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg border p-1 w-fit">
        <button
          onClick={() => setTab("skills")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "skills"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Wand2 className="h-4 w-4" />
          Skills
        </button>
        <button
          onClick={() => setTab("mcp")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "mcp"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Server className="h-4 w-4" />
          MCP Servers
        </button>
      </div>

      {/* Tab content */}
      {tab === "skills" ? (
        <SkillsTab workspaceId={selectedWorkspaceId} projectId={selectedProjectId} />
      ) : (
        <McpTab workspaceId={selectedWorkspaceId} projectId={selectedProjectId} />
      )}
    </div>
  );
}
