import { useState } from "react";
import { useWorkspaces, useProjects } from "@/lib/hooks";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wand2, Server } from "lucide-react";

import type { Tab } from "./skills-mcp-components/shared";
import { SkillsTab } from "./skills-mcp-components/SkillsTab";
import { McpTab } from "./skills-mcp-components/McpTab";

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
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Skills & MCP</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage skills and MCP servers across global, workspace, and project levels.
        </p>
      </div>

      {/* Scope selectors */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
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
