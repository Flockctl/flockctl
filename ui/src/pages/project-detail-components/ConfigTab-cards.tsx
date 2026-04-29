import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import {
  GitignoreToggles,
  type GitignoreTogglesValue,
} from "@/components/gitignore-toggles";
import type { MetaModel, PermissionMode, AIProviderKeyResponse } from "@/lib/types";

/**
 * Card groups extracted from ConfigTab.tsx. Each one renders a tight
 * settings cluster and binds directly to the form state owned by the parent
 * — no duplication of `useState` calls. The parent keeps the validation + the
 * two-step save (updateProject + updateProjectConfig); these components only
 * own their JSX. Split so the page-level file stays focused on the
 * orchestration plumbing instead of 600 lines of grid layout.
 */

/**
 * "General" card — DB-backed identity fields plus the AI-key allow-list and
 * permission-mode pair. The allow-list + permission mode live side-by-side
 * on wide screens because they're both access-control knobs.
 */
export function GeneralCard({
  name,
  setName,
  description,
  setDescription,
  repoUrl,
  setRepoUrl,
  path,
  allowedKeyIds,
  setAllowedKeyIds,
  keys,
  permissionMode,
  setPermissionMode,
}: {
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  description: string;
  setDescription: Dispatch<SetStateAction<string>>;
  repoUrl: string;
  setRepoUrl: Dispatch<SetStateAction<string>>;
  path: string | null | undefined;
  allowedKeyIds: number[];
  setAllowedKeyIds: Dispatch<SetStateAction<number[]>>;
  keys: AIProviderKeyResponse[];
  permissionMode: PermissionMode | null;
  setPermissionMode: (mode: PermissionMode | null) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <p className="text-xs text-muted-foreground">Stored locally on this machine.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        {path && (
          <div className="space-y-1">
            <Label className="text-muted-foreground">Path</Label>
            <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1">{path}</p>
          </div>
        )}

        <Separator />

        {/*
          Allowed AI keys and permission mode sit side-by-side — both are
          access-control knobs and read naturally as a pair. Collapses to
          one column under `md` where the checkbox list would otherwise
          overflow a narrow half-column.
        */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Allowed AI Keys *</Label>
            <p className="text-xs text-muted-foreground">
              At least one active key is required (clearing not permitted).
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
                  No active AI keys. Add one in Settings → AI Keys.
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
              Applied to tasks and chats in this project. Per-task overrides win.
            </p>
            <PermissionModeSelect
              value={permissionMode}
              onChange={setPermissionMode}
              inheritLabel="inherit from workspace"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Paired AI Configuration + Execution cards. Both persist to
 * `.flockctl/config.yaml`, so they sit side-by-side on wide screens and
 * collapse to a single column below `lg` to keep number inputs readable
 * on narrow windows.
 */
export function AIAndExecutionCards({
  model,
  setModel,
  planningModel,
  setPlanningModel,
  baseBranch,
  setBaseBranch,
  models,
  defaultTimeout,
  setDefaultTimeout,
  maxConcurrent,
  setMaxConcurrent,
  budgetDaily,
  setBudgetDaily,
  requiresApproval,
  setRequiresApproval,
  postTaskCmd,
  setPostTaskCmd,
}: {
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  planningModel: string;
  setPlanningModel: Dispatch<SetStateAction<string>>;
  baseBranch: string;
  setBaseBranch: Dispatch<SetStateAction<string>>;
  models: MetaModel[];
  defaultTimeout: string;
  setDefaultTimeout: Dispatch<SetStateAction<string>>;
  maxConcurrent: string;
  setMaxConcurrent: Dispatch<SetStateAction<string>>;
  budgetDaily: string;
  setBudgetDaily: Dispatch<SetStateAction<string>>;
  requiresApproval: boolean;
  setRequiresApproval: Dispatch<SetStateAction<boolean>>;
  postTaskCmd: string;
  setPostTaskCmd: Dispatch<SetStateAction<string>>;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* AI Configuration — .flockctl/config.yaml */}
      <Card>
        <CardHeader>
          <CardTitle>AI Configuration</CardTitle>
          <p className="text-xs text-muted-foreground">
            Stored in .flockctl/config.yaml — shared via git.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
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

      {/* Execution — .flockctl/config.yaml */}
      <Card>
        <CardHeader>
          <CardTitle>Execution</CardTitle>
          <p className="text-xs text-muted-foreground">
            Stored in .flockctl/config.yaml — shared via git.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="proj-timeout">Timeout (s)</Label>
              <Input
                id="proj-timeout"
                type="number"
                value={defaultTimeout}
                onChange={(e) => setDefaultTimeout(e.target.value)}
                placeholder="300"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-concurrent">Max concurrent</Label>
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
            <Label htmlFor="proj-approval">
              Require approval before task execution
            </Label>
          </label>

          <div className="space-y-2">
            <Label htmlFor="proj-post-task-cmd">Post-task command</Label>
            <Input
              id="proj-post-task-cmd"
              value={postTaskCmd}
              onChange={(e) => setPostTaskCmd(e.target.value)}
              placeholder="npm test"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Runs in the project dir after each task (e.g. tests, linting).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Paired Environment Variables + Gitignore cards. Env vars persist to
 * `.flockctl/config.yaml`; the gitignore toggles are DB-backed and
 * reconciled into the project's `.gitignore` on save.
 *
 * Below the pair we render a third full-width card for the
 * `use_project_claude_skills` opt-in (see migration 0045) — placed here
 * because, like the gitignore toggles, it is DB-backed and triggers a
 * reconcile when changed, but it gets its own card to make the
 * "locked-on, can't be disabled per-skill" intent explicit.
 */
export function EnvAndGitignoreCards({
  envVarsText,
  setEnvVarsText,
  gitignoreToggles,
  setGitignoreToggles,
  useProjectClaudeSkills,
  setUseProjectClaudeSkills,
  projectPath,
}: {
  envVarsText: string;
  setEnvVarsText: Dispatch<SetStateAction<string>>;
  gitignoreToggles: GitignoreTogglesValue;
  setGitignoreToggles: Dispatch<SetStateAction<GitignoreTogglesValue>>;
  useProjectClaudeSkills: boolean;
  setUseProjectClaudeSkills: Dispatch<SetStateAction<boolean>>;
  projectPath: string | null | undefined;
}) {
  return (
    <div className="space-y-6">
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Environment Variables — .flockctl/config.yaml */}
      <Card>
        <CardHeader>
          <CardTitle>Environment Variables</CardTitle>
          <p className="text-xs text-muted-foreground">
            .flockctl/config.yaml · one KEY=VALUE per line · # is a comment.
          </p>
        </CardHeader>
        <CardContent>
          <Textarea
            value={envVarsText}
            onChange={(e) => setEnvVarsText(e.target.value)}
            rows={5}
            placeholder={"NODE_ENV=production\nCI=true"}
            className="font-mono text-sm"
          />
        </CardContent>
      </Card>

      {/* Gitignore — DB-backed, reconciles on save */}
      <Card>
        <CardHeader>
          <CardTitle>Gitignore</CardTitle>
          <p className="text-xs text-muted-foreground">
            Local to this machine · rewrites the managed block in{" "}
            <code>{projectPath ?? "<project>"}/.gitignore</code> on save.
          </p>
        </CardHeader>
        <CardContent>
          <GitignoreToggles
            value={gitignoreToggles}
            onChange={setGitignoreToggles}
            title="Additional ignores"
            idPrefix="proj-gi"
          />
        </CardContent>
      </Card>
    </div>

    {/* Project-owned skills opt-in — DB-backed, reconciles on save */}
    <Card>
      <CardHeader>
        <CardTitle>Project skills source</CardTitle>
        <p className="text-xs text-muted-foreground">
          Local to this machine · controls whether the agent picks up skills
          from this project's own <code>.claude/skills/</code> folder.
        </p>
      </CardHeader>
      <CardContent>
        <label
          htmlFor="proj-use-claude-skills"
          className="flex items-start gap-2 text-sm"
        >
          <Checkbox
            id="proj-use-claude-skills"
            checked={useProjectClaudeSkills}
            onCheckedChange={(next) => setUseProjectClaudeSkills(next === true)}
          />
          <span className="flex-1">
            <span className="block leading-tight">
              Use skills from <code>.claude/skills/</code> in this project
            </span>
            <span className="block text-xs text-muted-foreground">
              When enabled, every <code>SKILL.md</code> under{" "}
              <code>{projectPath ?? "<project>"}/.claude/skills/</code> is
              treated as a locked, always-on skill that overrides any same-name
              skill from global / workspace / <code>.flockctl/skills/</code>.
              These skills bypass the per-skill disable list — they cannot be
              turned off through the toggles below.
            </span>
          </span>
        </label>
      </CardContent>
    </Card>
    </div>
  );
}
