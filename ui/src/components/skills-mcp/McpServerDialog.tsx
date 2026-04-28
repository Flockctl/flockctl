import { useMemo, useState } from "react";
import {
  useCreateGlobalMcpServer,
  useCreateWorkspaceMcpServer,
  useCreateProjectMcpServer,
  useGlobalSecrets,
  useWorkspaceSecrets,
  useProjectSecrets,
} from "@/lib/hooks";
import type { McpServer, McpServerConfig, SecretRecord } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { KeyRound } from "lucide-react";

/**
 * Create-or-edit dialog for an MCP server, shared between the sidebar McpPanel
 * and the full-page McpTab.
 *
 * Scope rules:
 *   - "global"    → only global secrets are offered as `${secret:NAME}` placeholders
 *   - "workspace" → global + workspace secrets
 *   - "project"   → global + workspace + project secrets
 *
 * Edit mode is signalled by passing a non-null `editServer`. In edit mode the
 * name field is locked (server name is the primary key on disk).
 */
export type McpServerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "workspace" | "project";
  workspaceId: string;
  /** Required for "project" scope; pass "" otherwise. */
  projectId: string;
  editServer?: McpServer | null;
};

export function McpServerDialog({
  open,
  onOpenChange,
  scope,
  workspaceId,
  projectId,
  editServer,
}: McpServerDialogProps) {
  const createGlobal = useCreateGlobalMcpServer();
  const createWorkspace = useCreateWorkspaceMcpServer(workspaceId);
  const createProject = useCreateProjectMcpServer(workspaceId, projectId);

  const globalSecretsQ = useGlobalSecrets();
  const workspaceSecretsQ = useWorkspaceSecrets(workspaceId);
  const projectSecretsQ = useProjectSecrets(projectId);

  const availableSecrets = useMemo<SecretRecord[]>(() => {
    const map = new Map<string, SecretRecord>();
    for (const s of globalSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    if (scope === "workspace" || scope === "project") {
      for (const s of workspaceSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    }
    if (scope === "project") {
      for (const s of projectSecretsQ.data?.secrets ?? []) map.set(s.name, s);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [globalSecretsQ.data, workspaceSecretsQ.data, projectSecretsQ.data, scope]);

  const [name, setName] = useState(editServer?.name ?? "");
  const [command, setCommand] = useState(editServer?.config.command ?? "");
  const [args, setArgs] = useState(editServer?.config.args?.join(" ") ?? "");
  const [envVars, setEnvVars] = useState(
    editServer?.config.env
      ? Object.entries(editServer.config.env).map(([k, v]) => `${k}=${v}`).join("\n")
      : "",
  );
  const [error, setError] = useState("");

  // Sync when editServer changes (dialog re-opens with a different server).
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

  function insertSecretPlaceholder(secretName: string) {
    const placeholder = "${secret:" + secretName + "}";
    setEnvVars((prev) => {
      const trimmed = prev.replace(/\s+$/, "");
      const prefix = trimmed ? trimmed + "\n" : "";
      return prefix + `${secretName}=${placeholder}\n`;
    });
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
      if (scope === "global") await createGlobal.mutateAsync(data);
      else if (scope === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createGlobal.isPending || createWorkspace.isPending || createProject.isPending;
  const isEditing = !!editServer;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit MCP Server" : `Add MCP Server (${scope})`}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Edit the "${editServer.name}" MCP server at ${scope} level.`
              : `Configure a new MCP server at the ${scope} level.`}
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
