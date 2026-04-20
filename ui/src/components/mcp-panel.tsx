import { useState, useMemo } from "react";
import {
  useGlobalMcpServers,
  useWorkspaceMcpServers,
  useProjectMcpServers,
  useCreateWorkspaceMcpServer,
  useCreateProjectMcpServer,
  useDeleteWorkspaceMcpServer,
  useDeleteProjectMcpServer,
  useWorkspaceDisabledMcpServers,
  useToggleWorkspaceDisabledMcpServer,
  useProjectDisabledMcpServers,
  useToggleProjectDisabledMcpServer,
  useGlobalSecrets,
  useWorkspaceSecrets,
  useProjectSecrets,
} from "@/lib/hooks";
import type { McpServer, McpServerConfig, SecretRecord } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Server, Plus, Trash2, Pencil, ChevronDown, ChevronRight, Eye, EyeOff, KeyRound } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

const levelColors: Record<string, string> = {
  global: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  workspace: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  project: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
};

// --- MCP Dialog (create + edit) ---

function McpDialog({
  open,
  onOpenChange,
  level,
  workspaceId,
  projectId,
  editServer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
  editServer?: McpServer | null;
}) {
  const createWorkspace = useCreateWorkspaceMcpServer(workspaceId);
  const createProject = useCreateProjectMcpServer(workspaceId, projectId ?? "");

  const globalSecretsQ = useGlobalSecrets();
  const workspaceSecretsQ = useWorkspaceSecrets(workspaceId);
  const projectSecretsQ = useProjectSecrets(projectId ?? "");

  const availableSecrets = useMemo<SecretRecord[]>(() => {
    const map = new Map<string, SecretRecord>();
    for (const s of globalSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    for (const s of workspaceSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    if (level === "project") {
      for (const s of projectSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [globalSecretsQ.data, workspaceSecretsQ.data, projectSecretsQ.data, level]);

  const [name, setName] = useState(editServer?.name ?? "");
  const [command, setCommand] = useState(editServer?.config.command ?? "");
  const [args, setArgs] = useState(editServer?.config.args?.join(" ") ?? "");
  const [envVars, setEnvVars] = useState(
    editServer?.config.env
      ? Object.entries(editServer.config.env).map(([k, v]) => `${k}=${v}`).join("\n")
      : "",
  );
  const [error, setError] = useState("");

  function insertSecretPlaceholder(secretName: string) {
    const placeholder = "${secret:" + secretName + "}";
    setEnvVars((prev) => {
      const trimmed = prev.replace(/\s+$/, "");
      const prefix = trimmed ? trimmed + "\n" : "";
      return prefix + `${secretName}=${placeholder}\n`;
    });
  }

  const [prevEdit, setPrevEdit] = useState<McpServer | null | undefined>(undefined);
  if (editServer !== prevEdit) {
    setPrevEdit(editServer);
    setName(editServer?.name ?? "");
    setCommand(editServer?.config.command ?? "");
    setArgs(editServer?.config.args?.join(" ") ?? "");
    setEnvVars(
      editServer?.config.env
        ? Object.entries(editServer.config.env).map(([k, v]) => `${k}=${v}`).join("\n")
        : "",
    );
    setError("");
  }

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
      if (level === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createWorkspace.isPending || createProject.isPending;
  const isEditing = !!editServer;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit MCP Server" : "Add MCP Server"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Edit the "${editServer.name}" MCP server at ${level} level.`
              : `Configure a new MCP server at the ${level} level.`}
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
              disabled={isEditing}
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
            <div className="flex items-center justify-between">
              <Label htmlFor="mcp-env">Environment variables (KEY=VALUE, one per line)</Label>
              {availableSecrets.length > 0 && (
                <Select value="" onValueChange={insertSecretPlaceholder}>
                  <SelectTrigger className="h-7 w-[200px] text-xs">
                    <SelectValue placeholder={
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <KeyRound className="h-3 w-3" /> Insert secret…
                      </span>
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSecrets.map((s) => (
                      <SelectItem key={`${s.scope}-${s.id}`} value={s.name} className="font-mono text-xs">
                        {s.name} <span className="text-muted-foreground">({s.scope})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Textarea
              id="mcp-env"
              placeholder={"GITHUB_TOKEN=${secret:GITHUB_TOKEN}"}
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              className="min-h-[80px] font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Use <code className="rounded bg-muted px-1">{"${secret:NAME}"}</code> to reference a stored secret. Placeholders are resolved when Claude Code loads the server; the raw value never lives in the committed config.
            </p>
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

// --- McpPanel ---

export function McpPanel({
  level,
  workspaceId,
  projectId,
}: {
  level: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
}) {
  const globalQ = useGlobalMcpServers();
  const wsQ = useWorkspaceMcpServers(workspaceId);
  const projQ = useProjectMcpServers(workspaceId, projectId ?? "");

  const servers = level === "project" ? (projQ.data ?? []) : (wsQ.data ?? []);
  const isLoading = level === "project" ? projQ.isLoading : wsQ.isLoading;

  const deleteWs = useDeleteWorkspaceMcpServer(workspaceId);
  const deleteProj = useDeleteProjectMcpServer(workspaceId, projectId ?? "");

  const wsDisabledQ = useWorkspaceDisabledMcpServers(workspaceId);
  const projDisabledQ = useProjectDisabledMcpServers(projectId ?? "");
  const toggleWsDisabled = useToggleWorkspaceDisabledMcpServer(workspaceId);
  const toggleProjDisabled = useToggleProjectDisabledMcpServer(projectId ?? "");

  const wsDisabledSet = useMemo(
    () => new Set((wsDisabledQ.data?.disabled_mcp_servers ?? []).map((e) => `${e.level}:${e.name}`)),
    [wsDisabledQ.data],
  );
  const projDisabledSet = useMemo(
    () => new Set((projDisabledQ.data?.disabled_mcp_servers ?? []).map((e) => `${e.level}:${e.name}`)),
    [projDisabledQ.data],
  );

  const inherited = useMemo<McpServer[]>(() => {
    const items: McpServer[] = [];
    if (globalQ.data) items.push(...globalQ.data);
    if (level === "project" && wsQ.data) items.push(...wsQ.data);
    return items;
  }, [globalQ.data, wsQ.data, level]);

  const deleteConfirm = useConfirmDialog();
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editServer, setEditServer] = useState<McpServer | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  function isInheritedDisabled(server: McpServer): boolean {
    const key = `${server.level}:${server.name}`;
    if (level === "workspace") return wsDisabledSet.has(key);
    return projDisabledSet.has(key);
  }

  function toggleInheritedDisable(server: McpServer) {
    const disabled = isInheritedDisabled(server);
    if (level === "workspace") {
      toggleWsDisabled.mutate({ name: server.name, level: server.level, disable: !disabled });
    } else {
      toggleProjDisabled.mutate({ name: server.name, level: server.level, disable: !disabled });
    }
  }

  function handleDelete(server: McpServer) {
    setDeleteTarget(server);
    deleteConfirm.requestConfirm(server.name);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut = level === "workspace" ? deleteWs : deleteProj;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  function handleCreate() {
    setEditServer(null);
    setDialogOpen(true);
  }

  function handleEdit(server: McpServer) {
    setEditServer(server);
    setDialogOpen(true);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <CardTitle>MCP Servers</CardTitle>
          </div>
          <Button size="sm" variant="outline" onClick={handleCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add Server
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          MCP server configs at the {level} level. Servers provide tools and context to AI agents.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {inherited.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Inherited ({level === "workspace" ? "global" : "global + workspace"})
            </p>
            <div className="divide-y rounded-md border">
              {inherited.map((server) => {
                const key = `${server.level}:${server.name}`;
                const isExpanded = expandedServer === key;
                const disabled = isInheritedDisabled(server);
                const isPending =
                  level === "workspace" ? toggleWsDisabled.isPending : toggleProjDisabled.isPending;
                return (
                  <div key={key}>
                    <div
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 ${disabled ? "opacity-50" : ""}`}
                      onClick={() => setExpandedServer(isExpanded ? null : key)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className={`text-sm font-medium flex-1 ${disabled ? "line-through" : ""}`}>
                        {server.name}
                      </span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {server.config.command}
                        {server.config.args ? ` ${server.config.args.join(" ")}` : ""}
                      </code>
                      <Badge variant="secondary" className={`text-xs ${levelColors[server.level]}`}>
                        {server.level}
                      </Badge>
                      {disabled && (
                        <Badge variant="outline" className="text-xs">disabled</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title={disabled ? `Enable at ${level}` : `Disable at ${level}`}
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleInheritedDisable(server);
                        }}
                      >
                        {disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-1 text-xs text-muted-foreground">
                        <div>
                          <span className="font-medium">command:</span>{" "}
                          <code className="rounded bg-muted px-1 py-0.5">{server.config.command}</code>
                        </div>
                        {server.config.args && server.config.args.length > 0 && (
                          <div>
                            <span className="font-medium">args:</span>{" "}
                            <code className="rounded bg-muted px-1 py-0.5">{server.config.args.join(" ")}</code>
                          </div>
                        )}
                        {server.config.env && Object.keys(server.config.env).length > 0 && (
                          <div>
                            <span className="font-medium">env:</span>{" "}
                            <code className="rounded bg-muted px-1 py-0.5">
                              {Object.entries(server.config.env).map(([k, v]) => `${k}=${v}`).join(", ")}
                            </code>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No MCP servers configured at this level.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {servers.map((server) => {
              const isExpanded = expandedServer === server.name;
              return (
                <div key={server.name}>
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedServer(isExpanded ? null : server.name)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-sm font-medium flex-1">{server.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {server.config.command}
                      {server.config.args ? ` ${server.config.args.join(" ")}` : ""}
                    </code>
                    <Badge variant="secondary" className={`text-xs ${levelColors[server.level]}`}>
                      {server.level}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(server);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
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
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-1 text-xs text-muted-foreground">
                      <div>
                        <span className="font-medium">command:</span>{" "}
                        <code className="rounded bg-muted px-1 py-0.5">{server.config.command}</code>
                      </div>
                      {server.config.args && server.config.args.length > 0 && (
                        <div>
                          <span className="font-medium">args:</span>{" "}
                          <code className="rounded bg-muted px-1 py-0.5">{server.config.args.join(" ")}</code>
                        </div>
                      )}
                      {server.config.env && Object.keys(server.config.env).length > 0 && (
                        <div>
                          <span className="font-medium">env:</span>{" "}
                          <code className="rounded bg-muted px-1 py-0.5">
                            {Object.entries(server.config.env).map(([k, v]) => `${k}=${v}`).join(", ")}
                          </code>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <McpDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        level={level}
        workspaceId={workspaceId}
        projectId={projectId}
        editServer={editServer}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete MCP Server"
        description={`Delete MCP server "${deleteTarget?.name}"? This cannot be undone.`}
        isPending={deleteWs.isPending || deleteProj.isPending}
        onConfirm={doDelete}
      />
    </Card>
  );
}
