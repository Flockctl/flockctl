import { useState, useMemo } from "react";
import {
  useGlobalMcpServers,
  useWorkspaceMcpServers,
  useProjectMcpServers,
  useDeleteGlobalMcpServer,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, ChevronDown, ChevronRight, EyeOff, Eye } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { levelColors } from "./shared";
import { McpConfigView } from "./McpConfigView";
import { CreateMcpDialog } from "./CreateMcpDialog";

// --- MCP Tab ---

export function McpTab({
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
