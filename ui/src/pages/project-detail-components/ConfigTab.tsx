import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useProject,
  useUpdateProject,
  useDeleteProject,
  useProjectConfig,
  useUpdateProjectConfig,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkillsPanel } from "@/components/skills-panel";
import { McpPanel } from "@/components/mcp-panel";
import { SecretsPanel } from "@/components/secrets-panel";
import { AgentsMdEditor } from "@/components/AgentsMdEditor";
import {
  DEFAULT_GITIGNORE_TOGGLES,
  type GitignoreTogglesValue,
} from "@/components/gitignore-toggles";
import type { PermissionMode } from "@/lib/types";
import { Save, Trash2 } from "lucide-react";
import {
  GeneralCard,
  AIAndExecutionCards,
  EnvAndGitignoreCards,
} from "@/pages/project-detail-components/ConfigTab-cards";

/**
 * "Config" tab of the redesigned project-detail page.
 *
 * Exposes the **full** settings surface for a project — everything that used
 * to live on the separate `/projects/:id/settings` page has been folded in
 * here, so there is no longer a "Full settings" link. Structure:
 *
 *   - **General** — DB-backed identity fields (name, description, repo URL,
 *     path, allowed AI keys, permission mode)
 *   - **AI Configuration** — `.flockctl/config.yaml` (model, planningModel,
 *     base branch)
 *   - **Execution** — `.flockctl/config.yaml` (default timeout, max concurrent
 *     tasks, daily budget, requiresApproval, post-task command)
 *   - **Environment Variables** — `.flockctl/config.yaml` (KEY=VALUE text)
 *   - **Gitignore** — DB-backed toggles reconciled to the project's
 *     `.gitignore` on save
 *   - **Agent documentation** — per-layer AGENTS.md editor (public + private
 *     layers)
 *   - **Skills / MCP / Secrets** — scoped to this project
 *   - **Danger Zone** — delete project
 *
 * Save is a single action that fans out into two mutations:
 *   1. `updateProject` (DB identity fields + gitignore toggles)
 *   2. `updateProjectConfig` (portable `.flockctl/config.yaml` fields)
 *
 * The three card groups (General / AI+Execution / Env+Gitignore) live in
 * `ConfigTab-cards.tsx`; the parent retains form state ownership and the
 * two-mutation save flow so nothing in the extraction changes behavior.
 */
export function ConfigTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate();

  const { data: project, isLoading, error } = useProject(projectId);
  const { data: config, isLoading: configLoading } = useProjectConfig(projectId);
  const { data: meta } = useMeta();
  const { data: aiKeys } = useAIKeys();
  const updateProject = useUpdateProject();
  const updateConfig = useUpdateProjectConfig();
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
  const [gitignoreToggles, setGitignoreToggles] = useState<GitignoreTogglesValue>(
    DEFAULT_GITIGNORE_TOGGLES,
  );
  // Per-project opt-in for honouring `<project>/.claude/skills/` as a locked,
  // non-disableable skill source (DB-backed; migration 0045). Defaults to
  // `false` until the user ticks the matching checkbox below or in the
  // create dialog.
  const [useProjectClaudeSkills, setUseProjectClaudeSkills] = useState(false);

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
      setGitignoreToggles({
        gitignore_flockctl: project.gitignore_flockctl ?? false,
        gitignore_todo: project.gitignore_todo ?? false,
        gitignore_agents_md: project.gitignore_agents_md ?? false,
      });
      setUseProjectClaudeSkills(project.use_project_claude_skills ?? false);
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

    // Mirror the POST /projects rule: at least one active key must remain
    // in the allow-list. Clearing is no longer permitted (PATCH rejects it
    // with 422) so we block the Save here to keep the error server-side.
    if (allowedKeyIds.length === 0) {
      setFormError("Pick at least one AI provider key.");
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
        id: projectId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          repoUrl: repoUrl.trim() || null,
          allowed_key_ids: allowedKeyIds,
          // Always send the current toggle state — the server only rewrites
          // `.gitignore` when at least one field is present in the PATCH body,
          // so sending the full triplet keeps "unchecking" work the same as
          // "checking" (avoids a stale block on toggle flip).
          gitignore_flockctl: gitignoreToggles.gitignore_flockctl,
          gitignore_todo: gitignoreToggles.gitignore_todo,
          gitignore_agents_md: gitignoreToggles.gitignore_agents_md,
          // Always send the current value so a flip from `true` → `false`
          // is persisted (omission would be treated as "leave unchanged" by
          // the PATCH handler).
          use_project_claude_skills: useProjectClaudeSkills,
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

      await updateConfig.mutateAsync({ projectId, config: configData });

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  if (isLoading || configLoading) {
    return (
      <div className="space-y-4" data-testid="project-config-tab">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <p className="text-destructive" data-testid="project-config-tab">
        {error ? `Failed to load project: ${error.message}` : "Project not found."}
      </p>
    );
  }

  return (
    <div className="space-y-6" data-testid="project-config-tab">
      {/* Save bar — pinned to the top of the tab. The tab already lives
          under a page header with the project title, so we don't repeat
          the title here. */}
      <div className="flex items-center justify-end gap-2">
        {saved && (
          <Badge variant="outline" className="border-green-500 text-green-600">
            Saved
          </Badge>
        )}
        <Button
          onClick={handleSave}
          disabled={updateProject.isPending || allowedKeyIds.length === 0}
          data-testid="project-config-save"
        >
          <Save className="mr-1.5 h-4 w-4" />
          {updateProject.isPending ? "Saving..." : "Save"}
        </Button>
      </div>

      {formError && (
        <p className="text-sm text-destructive" data-testid="project-config-error">
          {formError}
        </p>
      )}

      <GeneralCard
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        repoUrl={repoUrl}
        setRepoUrl={setRepoUrl}
        path={project.path}
        allowedKeyIds={allowedKeyIds}
        setAllowedKeyIds={setAllowedKeyIds}
        keys={keys}
        permissionMode={permissionMode}
        setPermissionMode={setPermissionMode}
      />

      <AIAndExecutionCards
        model={model}
        setModel={setModel}
        planningModel={planningModel}
        setPlanningModel={setPlanningModel}
        baseBranch={baseBranch}
        setBaseBranch={setBaseBranch}
        models={models}
        defaultTimeout={defaultTimeout}
        setDefaultTimeout={setDefaultTimeout}
        maxConcurrent={maxConcurrent}
        setMaxConcurrent={setMaxConcurrent}
        budgetDaily={budgetDaily}
        setBudgetDaily={setBudgetDaily}
        requiresApproval={requiresApproval}
        setRequiresApproval={setRequiresApproval}
        postTaskCmd={postTaskCmd}
        setPostTaskCmd={setPostTaskCmd}
      />

      <EnvAndGitignoreCards
        envVarsText={envVarsText}
        setEnvVarsText={setEnvVarsText}
        gitignoreToggles={gitignoreToggles}
        setGitignoreToggles={setGitignoreToggles}
        useProjectClaudeSkills={useProjectClaudeSkills}
        setUseProjectClaudeSkills={setUseProjectClaudeSkills}
        projectPath={project.path}
      />

      {/* Agent documentation (AGENTS.md) — per-layer editor: public (committed)
          and private (local-only). Each layer owns its own tab + save button.
          The effective preview below merges every layer including user and
          workspace scopes so you can see what agents actually read. */}
      <AgentsMdEditor
        scope="project"
        id={projectId}
        title="Agent documentation"
        description="Edit per layer. Public layer is committed with the repo; private stays local to this machine."
      />

      {/* Skills */}
      <SkillsPanel
        level="project"
        workspaceId={String(project.workspace_id)}
        projectId={projectId}
      />

      {/* MCP Servers */}
      <McpPanel
        level="project"
        workspaceId={String(project.workspace_id)}
        projectId={projectId}
      />

      {/* Secrets */}
      <SecretsPanel
        scope="project"
        workspaceId={String(project.workspace_id)}
        projectId={projectId}
      />

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

export default ConfigTab;
