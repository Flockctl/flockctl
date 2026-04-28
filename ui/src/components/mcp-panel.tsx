import { useState, useMemo } from "react";
import {
  useGlobalMcpServers,
  useWorkspaceMcpServers,
  useProjectMcpServers,
  useDeleteWorkspaceMcpServer,
  useDeleteProjectMcpServer,
  useWorkspaceDisabledMcpServers,
  useToggleWorkspaceDisabledMcpServer,
  useProjectDisabledMcpServers,
  useToggleProjectDisabledMcpServer,
} from "@/lib/hooks";
import type { McpServer } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Server, Plus, Trash2, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { DisableToggle } from "@/components/skills-mcp/DisableToggle";
import { McpServerDialog } from "@/components/skills-mcp/McpServerDialog";
import { levelColors } from "@/components/skills-mcp/shared";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

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
    // In the project view a server is effectively disabled if EITHER the
    // workspace OR the project itself disables it. Workspace disables
    // cascade to all child projects (see resolveMcpServersForProject) so the
    // UI must mirror that — otherwise the server looks "enabled" here while
    // the daemon has already filtered it out of the project's effective set.
    return wsDisabledSet.has(key) || projDisabledSet.has(key);
  }

  // True only when the disable comes from the workspace (so the user can't
  // toggle it off from the project view — it must be re-enabled at the
  // workspace level).
  function isDisabledByWorkspace(server: McpServer): boolean {
    if (level !== "project") return false;
    return wsDisabledSet.has(`${server.level}:${server.name}`);
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
                const inheritedDisable = isDisabledByWorkspace(server);
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
                        <Badge variant="outline" className="text-xs">
                          {inheritedDisable ? "disabled by workspace" : "disabled"}
                        </Badge>
                      )}
                      <DisableToggle
                        disabled={disabled}
                        title={
                          inheritedDisable
                            ? "Disabled at workspace level — re-enable in workspace settings"
                            : disabled
                              ? `Enable at ${level}`
                              : `Disable at ${level}`
                        }
                        pending={isPending || inheritedDisable}
                        onToggle={() => toggleInheritedDisable(server)}
                      />
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

      <McpServerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scope={level}
        workspaceId={workspaceId}
        projectId={projectId ?? ""}
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
