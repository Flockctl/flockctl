import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useWorkspace,
  useUpdateWorkspace,
  useDeleteWorkspace,
  useAIKeys,
  useWorkspaceConfig,
  useUpdateWorkspaceConfig,
  useWorkspaceAgentsMd,
  useUpdateWorkspaceAgentsMd,
} from "@/lib/hooks";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkillsPanel } from "@/components/skills-panel";
import { McpPanel } from "@/components/mcp-panel";
import { SecretsPanel } from "@/components/secrets-panel";
import { AgentsMdEditor } from "@/components/agents-md-editor";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import type { PermissionMode } from "@/lib/types";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

export default function WorkspaceSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();

  const { data: workspace, isLoading, error } = useWorkspace(workspaceId ?? "");
  const { data: wsConfig } = useWorkspaceConfig(workspaceId ?? "");
  const { data: aiKeys } = useAIKeys();
  const updateWorkspace = useUpdateWorkspace();
  const updateWsConfig = useUpdateWorkspaceConfig();
  const { data: agentsMd, isLoading: agentsMdLoading } = useWorkspaceAgentsMd(workspaceId ?? "");
  const updateAgentsMd = useUpdateWorkspaceAgentsMd();
  const deleteWorkspace = useDeleteWorkspace();

  const keys = (aiKeys ?? []).filter((k) => k.is_active);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setDescription(workspace.description ?? "");
      setAllowedKeyIds(workspace.allowed_key_ids ?? []);
    }
  }, [workspace]);

  useEffect(() => {
    if (wsConfig) {
      setPermissionMode((wsConfig.permissionMode as PermissionMode | undefined) ?? null);
    }
  }, [wsConfig]);

  async function handleSave() {
    setFormError("");
    setSaved(false);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }

    try {
      await updateWorkspace.mutateAsync({
        id: workspaceId!,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          allowed_key_ids: allowedKeyIds.length > 0 ? allowedKeyIds : null,
        },
      });
      await updateWsConfig.mutateAsync({
        workspaceId: workspaceId!,
        config: { permissionMode: permissionMode ?? null },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  if (!workspaceId) {
    return <p className="text-destructive">Missing workspace ID.</p>;
  }

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <p className="text-destructive">
        {error ? `Failed to load workspace: ${error.message}` : "Workspace not found."}
      </p>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Workspace Settings</h1>
            <p className="text-sm text-muted-foreground">{workspace.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <Badge variant="outline" className="border-green-500 text-green-600">
              Saved
            </Badge>
          )}
          <Button onClick={handleSave} disabled={updateWorkspace.isPending}>
            <Save className="mr-1.5 h-4 w-4" />
            {updateWorkspace.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {formError && (
        <p className="text-sm text-destructive">{formError}</p>
      )}

      {/* General */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Name *</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-desc">Description</Label>
            <Textarea
              id="ws-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          {workspace.path && (
            <div className="space-y-1">
              <Label className="text-muted-foreground">Path</Label>
              <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1">{workspace.path}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI Keys */}
      <Card>
        <CardHeader>
          <CardTitle>AI Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Allowed AI Keys</Label>
            <p className="text-xs text-muted-foreground">
              Restrict tasks to selected keys. None selected means all keys are allowed.
            </p>
            <div className="flex flex-wrap gap-3">
              {keys.map((k) => (
                <label key={k.id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={allowedKeyIds.includes(Number(k.id))}
                    onCheckedChange={(checked) =>
                      setAllowedKeyIds((prev) =>
                        checked
                          ? [...prev, Number(k.id)]
                          : prev.filter((id) => id !== Number(k.id)),
                      )
                    }
                  />
                  {k.name ?? k.label ?? `Key #${k.id}`}
                </label>
              ))}
              {keys.length === 0 && (
                <p className="text-xs text-muted-foreground">No active keys configured.</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Permission mode</Label>
            <p className="text-xs text-muted-foreground">
              Default mode for all projects in this workspace. Lower levels can override.
            </p>
            <div className="max-w-sm">
              <PermissionModeSelect
                value={permissionMode}
                onChange={setPermissionMode}
                inheritLabel="inherit from global default (auto)"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agent documentation (AGENTS.md) */}
      <AgentsMdEditor
        title="Agent documentation (workspace-wide)"
        description="Editable .flockctl/AGENTS.md. Cascades into every project's merged AGENTS.md, prepended above the project-level content."
        source={agentsMd?.source}
        effective={agentsMd?.effective}
        isLoading={agentsMdLoading}
        isSaving={updateAgentsMd.isPending}
        onSave={async (content) => {
          await updateAgentsMd.mutateAsync({ workspaceId: workspaceId!, content });
        }}
      />

      {/* Skills */}
      <SkillsPanel level="workspace" workspaceId={workspaceId} />

      {/* MCP Servers */}
      <McpPanel level="workspace" workspaceId={workspaceId} />

      {/* Secrets */}
      <SecretsPanel scope="workspace" workspaceId={workspaceId} />

      {/* Danger Zone */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete Workspace</p>
              <p className="text-xs text-muted-foreground">
                Permanently delete this workspace and remove all project associations.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete Workspace
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Workspace"
        description="This will permanently delete the workspace and remove all project associations. This action cannot be undone."
        isPending={deleteWorkspace.isPending}
        onConfirm={() => {
          deleteWorkspace.mutate(workspaceId, {
            onSuccess: () => {
              setDeleteOpen(false);
              navigate("/workspaces");
            },
          });
        }}
      />
    </div>
  );
}
