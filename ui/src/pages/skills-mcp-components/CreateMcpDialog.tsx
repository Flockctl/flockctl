import { useState } from "react";
import {
  useCreateGlobalMcpServer,
  useCreateWorkspaceMcpServer,
  useCreateProjectMcpServer,
} from "@/lib/hooks";
import type { McpServerConfig } from "@/lib/types";
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

// --- Create MCP Dialog ---

export function CreateMcpDialog({
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
