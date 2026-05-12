import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { FlatCard, SectionHeader } from "@/components/design";
import type { MetaModel, PermissionMode, AIProviderKeyResponse } from "@/lib/types";

/**
 * Card groups for {@link ConfigTab}, restyled in M23 slice 00 / T08.
 *
 * Surface look:
 * - **Containers** are `<FlatCard>`s grouping related rows; each card
 *   leads with a `<SectionHeader size="section">` so the page-level
 *   "Config" tab renders as a flat ladder of named sections, no shadcn
 *   `<Card>` chrome.
 * - **Rows** use a fixed `grid grid-cols-[200px_1fr] gap-4 items-baseline`
 *   layout — a 200px gutter for the label, the rest for the control. This
 *   matches `.flockctl/plan/ui-prototype.html` and keeps every label
 *   aligned regardless of input height (textarea, checkbox stack, etc.).
 * - **Labels** are `text-zinc-500 text-[12px]` — they're hints, not
 *   call-outs, because the field name is already the row's identity.
 *
 * Forms exception (CONTRIBUTING-DESIGN.md): we keep using shadcn
 * `Input` / `Textarea` / `Select` / `Checkbox` because rebuilding
 * accessible form primitives for the design tier is out of scope —
 * the redesign only standardises the layout chrome around them.
 *
 * The parent {@link ConfigTab} keeps full ownership of form state and the
 * two-step save flow (`updateProject` for DB-backed identity fields +
 * `updateProjectConfig` for `.flockctl/config.yaml`). These children are
 * pure JSX.
 */

/**
 * `<FormRow>` — the canonical 2-column form layout used everywhere on
 * this tab. Renders `[label][control]` on a `200px / 1fr` grid with
 * baseline alignment. The optional `hint` slot drops below the control
 * (still inside column 2) so explanatory text doesn't push the grid out
 * of alignment with neighbouring rows.
 *
 * Pass `htmlFor` if the control inside has a stable `id`; the label
 * becomes a real `<label>` and hover/click delegation works for free.
 * Otherwise the label is a plain `<span>` (some controls — checkboxes
 * with custom layout, segmented selects — own their own label nodes).
 */
function FormRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelClass = "text-zinc-500 text-[12px]";
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 items-baseline">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      <div className="space-y-1.5">
        {children}
        {hint && <div className="text-[11px] text-zinc-500">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * "General" card — DB-backed identity fields plus the AI-key allow-list and
 * permission-mode pair.
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
    <FlatCard className="p-5">
      <SectionHeader
        size="section"
        title="General"
        subtitle="Stored locally on this machine."
        data-testid="config-general-header"
      />
      <div className="space-y-4">
        <FormRow label="Name *" htmlFor="proj-name">
          <Input
            id="proj-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <FormRow label="Remote URL" htmlFor="proj-repo-url">
          <Input
            id="proj-repo-url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
            className="font-mono"
          />
        </FormRow>
        <FormRow label="Description" htmlFor="proj-desc">
          <Textarea
            id="proj-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </FormRow>
        {path && (
          <FormRow label="Path">
            <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1">
              {path}
            </p>
          </FormRow>
        )}

        <FormRow
          label="Allowed AI keys *"
          hint="At least one active key is required (clearing not permitted)."
        >
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
        </FormRow>

        <FormRow
          label="Permission mode"
          hint="Applied to tasks and chats in this project. Per-task overrides win."
        >
          <PermissionModeSelect
            value={permissionMode}
            onChange={setPermissionMode}
            inheritLabel="inherit from workspace"
          />
        </FormRow>
      </div>
    </FlatCard>
  );
}

/**
 * Paired AI Configuration + Execution cards. Both persist to
 * `.flockctl/config.yaml`. They sit side-by-side on wide screens and
 * collapse to a single column below `lg`.
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* AI Configuration — .flockctl/config.yaml */}
      <FlatCard className="p-5">
        <SectionHeader
          size="section"
          title="AI Configuration"
          subtitle="Stored in .flockctl/config.yaml — shared via git."
          data-testid="config-ai-header"
        />
        <div className="space-y-4">
          <FormRow label="Default model" htmlFor="proj-model">
            <Select
              value={model || "__none__"}
              onValueChange={(v) => setModel(v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="proj-model" aria-label="Default model">
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
          </FormRow>
          <FormRow label="Planning model" htmlFor="proj-planning-model">
            <Select
              value={planningModel || "__none__"}
              onValueChange={(v) =>
                setPlanningModel(v === "__none__" ? "" : v)
              }
            >
              <SelectTrigger
                id="proj-planning-model"
                aria-label="Planning model"
              >
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
          </FormRow>
          <FormRow label="Base branch" htmlFor="proj-branch">
            <Input
              id="proj-branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
            />
          </FormRow>
        </div>
      </FlatCard>

      {/* Execution — .flockctl/config.yaml */}
      <FlatCard className="p-5">
        <SectionHeader
          size="section"
          title="Execution"
          subtitle="Stored in .flockctl/config.yaml — shared via git."
          data-testid="config-execution-header"
        />
        <div className="space-y-4">
          <FormRow label="Timeout (s)" htmlFor="proj-timeout">
            <Input
              id="proj-timeout"
              type="number"
              value={defaultTimeout}
              onChange={(e) => setDefaultTimeout(e.target.value)}
              placeholder="300"
            />
          </FormRow>
          <FormRow label="Max concurrent" htmlFor="proj-concurrent">
            <Input
              id="proj-concurrent"
              type="number"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
              placeholder="5"
            />
          </FormRow>
          <FormRow label="Daily budget (USD)" htmlFor="proj-budget">
            <Input
              id="proj-budget"
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              placeholder="10.00"
            />
          </FormRow>
          <FormRow label="Approval">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                id="proj-approval"
                checked={requiresApproval}
                onCheckedChange={(checked) => setRequiresApproval(!!checked)}
              />
              <span>Require approval before task execution</span>
            </label>
          </FormRow>
          <FormRow
            label="Post-task command"
            htmlFor="proj-post-task-cmd"
            hint="Runs in the project dir after each task (e.g. tests, linting)."
          >
            <Input
              id="proj-post-task-cmd"
              value={postTaskCmd}
              onChange={(e) => setPostTaskCmd(e.target.value)}
              placeholder="npm test"
              className="font-mono"
            />
          </FormRow>
        </div>
      </FlatCard>
    </div>
  );
}

/**
 * Paired Environment Variables + Gitignore cards plus a third
 * full-width card for the `use_project_claude_skills` opt-in.
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
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Environment Variables — .flockctl/config.yaml */}
        <FlatCard className="p-5">
          <SectionHeader
            size="section"
            title="Environment Variables"
            subtitle=".flockctl/config.yaml · one KEY=VALUE per line · # is a comment."
            data-testid="config-env-header"
          />
          <FormRow label="KEY=VALUE" htmlFor="proj-env-vars">
            <Textarea
              id="proj-env-vars"
              value={envVarsText}
              onChange={(e) => setEnvVarsText(e.target.value)}
              rows={5}
              placeholder={"NODE_ENV=production\nCI=true"}
              className="font-mono text-sm"
            />
          </FormRow>
        </FlatCard>

        {/* Gitignore — DB-backed, reconciles on save */}
        <FlatCard className="p-5">
          <SectionHeader
            size="section"
            title="Gitignore"
            subtitle="Local · rewrites the managed block in the project's .gitignore on save."
            data-testid="config-gitignore-header"
          />
          <FormRow
            label="Additional ignores"
            hint={
              <>
                Rewrites <code>{projectPath ?? "<project>"}/.gitignore</code>{" "}
                on save.
              </>
            }
          >
            <GitignoreToggles
              value={gitignoreToggles}
              onChange={setGitignoreToggles}
              title="Additional ignores"
              idPrefix="proj-gi"
            />
          </FormRow>
        </FlatCard>
      </div>

      {/* Project-owned skills opt-in — DB-backed, reconciles on save */}
      <FlatCard className="p-5">
        <SectionHeader
          size="section"
          title="Project skills source"
          subtitle="Local · controls whether the agent picks up skills from this project's own .claude/skills/ folder."
          data-testid="config-claude-skills-header"
        />
        <FormRow label="Project .claude/skills/">
          <label
            htmlFor="proj-use-claude-skills"
            className="flex items-start gap-2 text-sm"
          >
            <Checkbox
              id="proj-use-claude-skills"
              checked={useProjectClaudeSkills}
              onCheckedChange={(next) =>
                setUseProjectClaudeSkills(next === true)
              }
            />
            <span className="flex-1">
              <span className="block leading-tight">
                Use skills from <code>.claude/skills/</code> in this project
              </span>
              <span className="block text-[11px] text-zinc-500">
                When enabled, every <code>SKILL.md</code> under{" "}
                <code>{projectPath ?? "<project>"}/.claude/skills/</code> is
                treated as a locked, always-on skill that overrides any
                same-name skill from global / workspace /{" "}
                <code>.flockctl/skills/</code>. These skills bypass the
                per-skill disable list — they cannot be turned off through
                the toggles below.
              </span>
            </span>
          </label>
        </FormRow>
      </FlatCard>
    </div>
  );
}
