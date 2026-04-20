import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useProject,
  useUpdateProject,
  useDeleteProject,
  useProjectConfig,
  useUpdateProjectConfig,
  useProjectAgentsMd,
  useUpdateProjectAgentsMd,
  useMeta,
  useAIKeys,
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
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkillsPanel } from "@/components/skills-panel";
import { McpPanel } from "@/components/mcp-panel";
import { SecretsPanel } from "@/components/secrets-panel";
import { AgentsMdEditor } from "@/components/agents-md-editor";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import type { PermissionMode } from "@/lib/types";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const { data: project, isLoading, error } = useProject(projectId ?? "");
  const { data: config, isLoading: configLoading } = useProjectConfig(projectId ?? "");
  const { data: meta } = useMeta();
  const { data: aiKeys } = useAIKeys();
  const updateProject = useUpdateProject();
  const updateConfig = useUpdateProjectConfig();
  const { data: agentsMd, isLoading: agentsMdLoading } = useProjectAgentsMd(projectId ?? "");
  const updateAgentsMd = useUpdateProjectAgentsMd();
  const deleteProject = useDeleteProject();

  const models = meta?.models ?? [];
  const keys = (aiKeys ?? []).filter((k) => k.is_active);

  // --- General fields ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [model, setModel] = useState("");
  const [planningModel, setPlanningModel] = useState("");
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);

  // --- Config fields ---
  const [postTaskCmd, setPostTaskCmd] = useState("");
  const [defaultTimeout, setDefaultTimeout] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("");
  const [budgetDaily, setBudgetDaily] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [envVarsText, setEnvVarsText] = useState("");

  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Initialize DB-backed identity fields from project row
  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description ?? "");
      setRepoUrl(project.repo_url ?? "");
      setAllowedKeyIds(project.allowed_key_ids ?? []);
    }
  }, [project]);

  // Initialize portable settings from .flockctl/config.yaml
  useEffect(() => {
    if (config) {
      setModel(config.model ?? "");
      setPlanningModel(config.planningModel ?? "");
      setBaseBranch(config.baseBranch ?? "main");
      setPostTaskCmd(config.testCommand ?? "");
      setDefaultTimeout(config.defaultTimeout?.toString() ?? "");
      setMaxConcurrent(config.maxConcurrentTasks?.toString() ?? "");
      setBudgetDaily(config.budgetDailyUsd?.toString() ?? "");
      setRequiresApproval(config.requiresApproval ?? false);
      setPermissionMode((config.permissionMode as PermissionMode | undefined) ?? null);
      setEnvVarsText(
        config.env
          ? Object.entries(config.env)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")
          : "",
      );
    }
  }, [config]);

  async function handleSave() {
    setFormError("");
    setSaved(false);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }

    const parsedEnv: Record<string, string> = {};
    for (const line of envVarsText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        parsedEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }

    try {
      // 1. Save DB-backed identity fields (local to this machine)
      await updateProject.mutateAsync({
        id: projectId!,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          repoUrl: repoUrl.trim() || null,
          allowed_key_ids: allowedKeyIds.length > 0 ? allowedKeyIds : null,
        },
      });

      // 2. Save .flockctl/config.yaml — portable across machines via git.
      //    permissionMode lives here too (not in DB).
      const configData: Record<string, any> = {
        model: model.trim() || null,
        planningModel: planningModel.trim() || null,
        baseBranch: baseBranch.trim() || null,
        testCommand: postTaskCmd.trim() || null,
        defaultTimeout: defaultTimeout ? parseInt(defaultTimeout) || null : null,
        maxConcurrentTasks: maxConcurrent ? parseInt(maxConcurrent) || null : null,
        budgetDailyUsd: budgetDaily ? parseFloat(budgetDaily) || null : null,
        requiresApproval: requiresApproval || null,
        permissionMode: permissionMode ?? null,
        env: Object.keys(parsedEnv).length > 0 ? parsedEnv : null,
      };

      await updateConfig.mutateAsync({ projectId: projectId!, config: configData });

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  if (!projectId) {
    return <p className="text-destructive">Missing project ID.</p>;
  }

  if (isLoading || configLoading) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <p className="text-destructive">
        {error ? `Failed to load project: ${error.message}` : "Project not found."}
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
            onClick={() => navigate(`/projects/${projectId}`)}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Project Settings</h1>
            <p className="text-sm text-muted-foreground">{project.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <Badge variant="outline" className="border-green-500 text-green-600">
              Saved
            </Badge>
          )}
          <Button onClick={handleSave} disabled={updateProject.isPending}>
            <Save className="mr-1.5 h-4 w-4" />
            {updateProject.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {formError && (
        <p className="text-sm text-destructive">{formError}</p>
      )}

      {/* General — stored in database (local to this machine) */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <p className="text-xs text-muted-foreground">Stored locally on this machine.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proj-name">Name *</Label>
              <Input
                id="proj-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-repo-url">Remote URL</Label>
              <Input
                id="proj-repo-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="proj-desc">Description</Label>
            <Textarea
              id="proj-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          {project.path && (
            <div className="space-y-1">
              <Label className="text-muted-foreground">Path</Label>
              <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1">{project.path}</p>
            </div>
          )}

          <Separator />

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

          <Separator />

          <div className="space-y-2">
            <Label>Permission mode</Label>
            <p className="text-xs text-muted-foreground">
              Applied to tasks and chats in this project. Tasks/chats can override it.
            </p>
            <div className="max-w-sm">
              <PermissionModeSelect
                value={permissionMode}
                onChange={setPermissionMode}
                inheritLabel="inherit from workspace"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Configuration — stored in .flockctl/config.yaml (shared via git) */}
      <Card>
        <CardHeader>
          <CardTitle>AI Configuration</CardTitle>
          <p className="text-xs text-muted-foreground">Stored in .flockctl/config.yaml — shared across machines via git.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proj-model">Default Model</Label>
              <Select
                value={model || "__none__"}
                onValueChange={(v) => setModel(v === "__none__" ? "" : v)}
              >
                <SelectTrigger id="proj-model">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No default</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-planning-model">Planning Model</Label>
              <Select
                value={planningModel || "__none__"}
                onValueChange={(v) => setPlanningModel(v === "__none__" ? "" : v)}
              >
                <SelectTrigger id="proj-planning-model">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No default</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="proj-branch">Base Branch</Label>
            <Input
              id="proj-branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
            />
          </div>

        </CardContent>
      </Card>

      {/* Execution — stored in .flockctl/config.yaml */}
      <Card>
        <CardHeader>
          <CardTitle>Execution</CardTitle>
          <p className="text-xs text-muted-foreground">Stored in .flockctl/config.yaml — shared across machines via git.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proj-timeout">Default Timeout (seconds)</Label>
              <Input
                id="proj-timeout"
                type="number"
                value={defaultTimeout}
                onChange={(e) => setDefaultTimeout(e.target.value)}
                placeholder="300"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-concurrent">Max Concurrent Tasks</Label>
              <Input
                id="proj-concurrent"
                type="number"
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
                placeholder="5"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="proj-budget">Daily Budget (USD)</Label>
            <Input
              id="proj-budget"
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              placeholder="10.00"
            />
          </div>

          <label className="flex items-center gap-3">
            <Checkbox
              id="proj-approval"
              checked={requiresApproval}
              onCheckedChange={(checked) => setRequiresApproval(!!checked)}
            />
            <Label htmlFor="proj-approval">Require approval before task execution</Label>
          </label>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="proj-post-task-cmd">Post Task Execution Command</Label>
            <p className="text-xs text-muted-foreground">
              Command to run after each task completes. Executed in the project directory (e.g. tests, linting).
            </p>
            <Input
              id="proj-post-task-cmd"
              value={postTaskCmd}
              onChange={(e) => setPostTaskCmd(e.target.value)}
              placeholder="npm test"
              className="font-mono"
            />
          </div>
        </CardContent>
      </Card>

      {/* Environment Variables — stored in .flockctl/config.yaml */}
      <Card>
        <CardHeader>
          <CardTitle>Environment Variables</CardTitle>
          <p className="text-xs text-muted-foreground">Stored in .flockctl/config.yaml — shared across machines via git.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            One per line, KEY=VALUE format. Lines starting with # are ignored.
          </p>
          <Textarea
            value={envVarsText}
            onChange={(e) => setEnvVarsText(e.target.value)}
            rows={5}
            placeholder={"NODE_ENV=production\nCI=true"}
            className="font-mono text-sm"
          />
        </CardContent>
      </Card>

      {/* Agent documentation (AGENTS.md) */}
      <AgentsMdEditor
        title="Agent documentation"
        description="Editable .flockctl/AGENTS.md. Merged with workspace AGENTS.md (if any) into root AGENTS.md; CLAUDE.md is symlinked to it."
        source={agentsMd?.source}
        effective={agentsMd?.effective}
        isLoading={agentsMdLoading}
        isSaving={updateAgentsMd.isPending}
        onSave={async (content) => {
          await updateAgentsMd.mutateAsync({ projectId: projectId!, content });
        }}
      />

      {/* Skills */}
      <SkillsPanel level="project" workspaceId={String(project.workspace_id)} projectId={projectId} />

      {/* MCP Servers */}
      <McpPanel level="project" workspaceId={String(project.workspace_id)} projectId={projectId} />

      {/* Secrets */}
      <SecretsPanel scope="project" workspaceId={String(project.workspace_id)} projectId={projectId} />

      {/* Danger Zone */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete Project</p>
              <p className="text-xs text-muted-foreground">
                Permanently delete this project and all its milestones, slices, and tasks.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete Project
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Project"
        description="This will permanently delete the project and all its milestones, slices, and tasks. This action cannot be undone."
        isPending={deleteProject.isPending}
        onConfirm={() => {
          deleteProject.mutate(projectId, {
            onSuccess: () => {
              setDeleteOpen(false);
              navigate("/projects");
            },
          });
        }}
      />
    </div>
  );
}
