import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useWorkspace,
  useUpdateWorkspace,
  useDeleteWorkspace,
  useAIKeys,
  useWorkspaceConfig,
  useUpdateWorkspaceConfig,
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
import { AgentsMdEditor } from "@/components/AgentsMdEditor";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import {
  GitignoreToggles,
  DEFAULT_GITIGNORE_TOGGLES,
  type GitignoreTogglesValue,
} from "@/components/gitignore-toggles";
import type { PermissionMode } from "@/lib/types";
import { Save, Trash2 } from "lucide-react";

/**
 * "Config" tab of the redesigned workspace-detail page.
 *
 * Lifts the card-level sections out of the old `/workspaces/:id/settings`
 * page (`workspace-settings.tsx`) and composes them into a single scrollable
 * column, mirroring the shape of `ConfigTab.tsx` for projects. The tab owns
 * the form state and the two-mutation save (`updateWorkspace` +
 * `updateWorkspaceConfig`) so the JSX-level structure matches the source
 * page one-for-one — no behavior rewrite.
 *
 * Sections, in order:
 *   1. General — DB-backed identity (name, description, path)
 *   2. AI Configuration — workspace-only fields (allowed AI keys,
 *      permission mode). **Not** the project-level Model / Execution /
 *      Provider Fallback Chain cards; workspace schema doesn't expose
 *      those and promoting them is out of scope for this milestone.
 *   3. Gitignore toggles — DB-backed, reconciled into `.gitignore` on save
 *   4. Agent documentation (AGENTS.md) — per-layer editor
 *   5. Skills — workspace-scoped skill selection
 *   6. MCP — workspace-scoped MCP server selection
 *   7. Secrets — workspace-scoped
 *   8. Danger Zone — delete workspace
 *
 * The page-level concerns of the old settings page (back button, title
 * header) move to the surrounding workspace-detail shell — this component
 * only owns the Config tab body.
 */
export function WorkspaceConfigTab({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();

  const { data: workspace, isLoading, error } = useWorkspace(workspaceId);
  const { data: wsConfig, isLoading: configLoading } = useWorkspaceConfig(workspaceId);
  const { data: aiKeys } = useAIKeys();
  const updateWorkspace = useUpdateWorkspace();
  const updateWsConfig = useUpdateWorkspaceConfig();
  const deleteWorkspace = useDeleteWorkspace();

  const keys = (aiKeys ?? []).filter((k) => k.is_active);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [gitignoreToggles, setGitignoreToggles] = useState<GitignoreTogglesValue>(
    DEFAULT_GITIGNORE_TOGGLES,
  );
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setDescription(workspace.description ?? "");
      setAllowedKeyIds(workspace.allowed_key_ids ?? []);
      setGitignoreToggles({
        gitignore_flockctl: workspace.gitignore_flockctl ?? false,
        gitignore_todo: workspace.gitignore_todo ?? false,
        gitignore_agents_md: workspace.gitignore_agents_md ?? false,
      });
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

    // Mirror the POST /workspaces rule: at least one active key must remain
    // in the allow-list. Clearing is no longer permitted (PATCH rejects it
    // with 422) so we block the Save here to keep the error server-side.
    if (allowedKeyIds.length === 0) {
      setFormError("Pick at least one AI provider key.");
      return;
    }

    try {
      await updateWorkspace.mutateAsync({
        id: workspaceId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          allowed_key_ids: allowedKeyIds,
          // Always send all three — the reconciler only runs when a toggle
          // changes, so sending the full triplet makes "unchecking" work the
          // same way "checking" does (see ConfigTab.tsx for the project mirror).
          gitignore_flockctl: gitignoreToggles.gitignore_flockctl,
          gitignore_todo: gitignoreToggles.gitignore_todo,
          gitignore_agents_md: gitignoreToggles.gitignore_agents_md,
        },
      });
      await updateWsConfig.mutateAsync({
        workspaceId,
        config: { permissionMode: permissionMode ?? null },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  if (isLoading || configLoading) {
    return (
      <div className="space-y-4" data-testid="workspace-config-tab">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <p className="text-destructive" data-testid="workspace-config-tab">
        {error ? `Failed to load workspace: ${error.message}` : "Workspace not found."}
      </p>
    );
  }

  return (
    <div className="space-y-6" data-testid="workspace-config-tab">
      {/* Save bar — pinned to the top of the tab. The tab already lives
          under a page header with the workspace title, so we don't repeat
          the title here. */}
      <div className="flex items-center justify-end gap-2">
        {saved && (
          <Badge variant="outline" className="border-green-500 text-green-600">
            Saved
          </Badge>
        )}
        <Button
          onClick={handleSave}
          disabled={updateWorkspace.isPending || allowedKeyIds.length === 0}
          data-testid="workspace-config-save"
        >
          <Save className="mr-1.5 h-4 w-4" />
          {updateWorkspace.isPending ? "Saving..." : "Save"}
        </Button>
      </div>

      {formError && (
        <p className="text-sm text-destructive" data-testid="workspace-config-error">
          {formError}
        </p>
      )}

      {/* 1. General */}
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
              <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1">
                {workspace.path}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. AI Configuration — workspace-only fields.
          Workspaces today carry a thinner AI surface than projects: just the
          allow-list and the default permission mode. Model / Execution /
          Provider Fallback Chain cards are project-only and intentionally
          NOT promoted here. */}
      <Card>
        <CardHeader>
          <CardTitle>AI Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Allowed AI Keys *</Label>
            <p className="text-xs text-muted-foreground">
              Pick at least one active key the workspace is allowed to use.
              Access is opt-in — clearing the list is not permitted (the
              workspace would be unusable).
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
                <p className="text-xs text-destructive">
                  No active AI keys configured. Add one in Settings → AI Keys.
                </p>
              )}
            </div>
            {keys.length > 0 && allowedKeyIds.length === 0 && (
              <p className="text-xs text-destructive">
                Select at least one key to save.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Permission mode</Label>
            <p className="text-xs text-muted-foreground">
              Default mode for all projects in this workspace. Lower levels
              can override.
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

      {/* 3. Gitignore — DB-backed, reconciled on save */}
      <Card>
        <CardHeader>
          <CardTitle>Gitignore</CardTitle>
          <p className="text-xs text-muted-foreground">
            Stored locally on this machine. Applied to the auto-managed block
            inside <code>{workspace.path}/.gitignore</code> on the next
            reconcile (saved triggers one automatically).
          </p>
        </CardHeader>
        <CardContent>
          <GitignoreToggles
            value={gitignoreToggles}
            onChange={setGitignoreToggles}
            title="Additional ignores"
            idPrefix="ws-gi"
          />
        </CardContent>
      </Card>

      {/* 4. Agent documentation (AGENTS.md) — per-layer: public (shared via
          git) and private (local-only). Each layer gets its own tab; the
          effective preview merges every layer that flows into child
          projects. */}
      <AgentsMdEditor
        scope="workspace"
        id={workspaceId}
        title="Agent documentation (workspace-wide)"
        description="Edit per layer. Both layers cascade into every project in this workspace."
      />

      {/* 5. Skills */}
      <SkillsPanel level="workspace" workspaceId={workspaceId} />

      {/* 6. MCP Servers */}
      <McpPanel level="workspace" workspaceId={workspaceId} />

      {/* 7. Secrets */}
      <SecretsPanel scope="workspace" workspaceId={workspaceId} />

      {/* 8. Danger Zone */}
      <Card
        className="border-destructive/50"
        data-testid="workspace-config-danger-zone"
      >
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete Workspace</p>
              <p className="text-xs text-muted-foreground">
                Permanently delete this workspace and remove all project
                associations.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              data-testid="workspace-config-delete"
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

export default WorkspaceConfigTab;
