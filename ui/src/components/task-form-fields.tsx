import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useMeta,
  useAIKeys,
  useProjects,
  useWorkspaces,
  useProjectAllowedKeys,
} from "@/lib/hooks";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import type { PermissionMode } from "@/lib/types";
import { filterKeysByAllowList, filterModelsForKey } from "@/lib/provider-agents";
import { useEffect } from "react";

export interface TaskFormValues {
  agent: string;
  model: string;
  prompt: string;
  timeout: string;
  assignedKeyId: string;
  selectedWorkspaceId: string;
  selectedProjectId: string;
  permissionMode: PermissionMode | null;
  /**
   * Worktree-isolation opt-in. When true, the submitter maps it to
   * `isolation: 'worktree'` on the API payload and the executor
   * materialises a per-task git worktree under
   * `<project>/.flockctl/worktrees/task-<id>/` before launch
   * (matches `claude --worktree`). False = legacy shared-cwd behaviour.
   */
  isolateWorktree: boolean;
}

export const defaultTaskFormValues: TaskFormValues = {
  agent: "",
  model: "",
  prompt: "",
  timeout: "300",
  assignedKeyId: "",
  selectedWorkspaceId: "",
  selectedProjectId: "",
  permissionMode: null,
  isolateWorktree: false,
};

interface TaskFormFieldsProps {
  values: TaskFormValues;
  onChange: (values: TaskFormValues) => void;
  /** Prefix for input IDs to avoid collisions when multiple forms exist */
  idPrefix: string;
  /** Hide the Agent selector (templates don't carry an agent binding today). */
  hideAgent?: boolean;
  /**
   * Hide the Model selector. Used by templates — model selection has
   * moved onto schedules so a template can be reused with different
   * models per schedule (matches the same migration `assigned_key_id`
   * already went through). Without this flag, a template author would
   * pick a model in the form, the field would be persisted on disk,
   * and the schedule UI's model picker would silently override it on
   * fire — confusing both ways.
   */
  hideModel?: boolean;
  /**
   * Hide the AI Key selector. Same rationale as `hideModel`: AI key is
   * configured per schedule, not on the template. The legacy note
   * directly under TaskFormFields ("AI key is configured per schedule…")
   * lives on the parent dialog and should be removed alongside this
   * flag — keeping the field hidden makes the note redundant.
   */
  hideKey?: boolean;
  /** Hide the Workspace/Project row — templates carry their own scope binding. */
  hideWorkspaceProject?: boolean;
  /** Render AI Key above Model instead of the default (Model → AI Key) order. */
  keyBeforeModel?: boolean;
  /**
   * Hide the worktree-isolation checkbox (rare — used by surfaces where
   * the field doesn't apply, e.g. a future `flockctl run` ad-hoc form
   * that bypasses the executor pipeline). Defaults to visible.
   */
  hideIsolation?: boolean;
}

export function TaskFormFields({
  values,
  onChange,
  idPrefix,
  hideAgent = false,
  hideModel = false,
  hideKey = false,
  hideWorkspaceProject = false,
  keyBeforeModel = false,
  hideIsolation = false,
}: TaskFormFieldsProps) {
  const { data: meta } = useMeta();
  const { data: aiKeys } = useAIKeys();
  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();

  const agents = meta?.agents?.filter(a => a.available) ?? [];
  const allModels = meta?.models ?? [];
  const activeKeys = (aiKeys ?? []).filter(k => k.is_active);

  // When the form has a project selected, restrict the key picker to the
  // project's effective allow-list (workspace → project inheritance applied
  // server-side). No project selected yet → show every active key so the
  // user can still pick one before the project drops the allow-list in.
  const { data: allowed } = useProjectAllowedKeys(values.selectedProjectId, {
    enabled: !!values.selectedProjectId,
  });
  const keys = values.selectedProjectId
    ? filterKeysByAllowList(activeKeys, allowed?.allowedKeyIds ?? null)
    : activeKeys;

  // If the previously-picked key is no longer permitted under the newly-chosen
  // project, reset to auto so we don't submit an impossible pairing. The
  // backend would reject it anyway — this just gives the user immediate
  // feedback and avoids a confusing 422 on submit.
  useEffect(() => {
    if (!values.selectedProjectId) return;
    if (!values.assignedKeyId || values.assignedKeyId === "__auto__") return;
    if (keys.some((k) => String(k.id) === values.assignedKeyId)) return;
    onChange({ ...values, assignedKeyId: "__auto__" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.selectedProjectId, allowed?.allowedKeyIds]);

  // Model dropdown is constrained by the selected key's provider so a user
  // assigned to a Claude Code key can't pick a GPT model (and vice versa).
  // `__auto__` / unset → no constraint, show the full catalogue.
  const metaKeys = (meta?.keys ?? []);
  const selectedKeyId = values.assignedKeyId && values.assignedKeyId !== "__auto__"
    ? values.assignedKeyId
    : null;
  const models = filterModelsForKey(allModels, metaKeys, selectedKeyId);

  // If the current model selection is no longer valid under the new key,
  // reset to "Default" so the form never submits an impossible pairing.
  useEffect(() => {
    if (
      values.model &&
      values.model !== "__default__" &&
      models.length > 0 &&
      !models.some((m) => m.id === values.model)
    ) {
      onChange({ ...values, model: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeyId]);

  const filteredProjects = values.selectedWorkspaceId
    ? (projectsList ?? []).filter(p => String(p.workspace_id) === values.selectedWorkspaceId)
    : (projectsList ?? []);

  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  const agentField = hideAgent ? null : (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-agent`}>Agent</Label>
      <Select value={values.agent} onValueChange={(v) => set("agent", v)}>
        <SelectTrigger id={`${idPrefix}-agent`}>
          <SelectValue placeholder="Select agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const modelField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-model`}>Model</Label>
      <Select value={values.model} onValueChange={(v) => set("model", v)}>
        <SelectTrigger id={`${idPrefix}-model`}>
          <SelectValue placeholder="Default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">Default</SelectItem>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const keyField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-key`}>AI Key</Label>
      <Select value={values.assignedKeyId} onValueChange={(v) => set("assignedKeyId", v)}>
        <SelectTrigger id={`${idPrefix}-key`}>
          <SelectValue placeholder="Auto (by priority)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__auto__">Auto (by priority)</SelectItem>
          {keys.map((k) => (
            <SelectItem key={k.id} value={String(k.id)}>
              {k.name ?? k.label ?? `Key #${k.id}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  // Model / Key fields are conditionally hidden for templates — both
  // moved onto Schedules in the same way `assigned_key_id` did. Pass
  // `null` (rendered nothing) instead of stripping the slot entirely
  // so the conditional below stays one clean expression.
  const visibleModelField = hideModel ? null : modelField;
  const visibleKeyField = hideKey ? null : keyField;

  return (
    <>
      {agentField}

      {keyBeforeModel ? (
        <>
          {visibleKeyField}
          {visibleModelField}
        </>
      ) : (
        <>
          {visibleModelField}
          {visibleKeyField}
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-prompt`}>Prompt</Label>
        <Textarea
          id={`${idPrefix}-prompt`}
          placeholder="Task prompt..."
          value={values.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={3}
        />
      </div>

      {!hideWorkspaceProject && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-workspace`}>Workspace</Label>
            <Select
              value={values.selectedWorkspaceId || "__none__"}
              onValueChange={(v) => onChange({ ...values, selectedWorkspaceId: v === "__none__" ? "" : v, selectedProjectId: "" })}
            >
              <SelectTrigger id={`${idPrefix}-workspace`}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {(workspacesList ?? []).map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-project`}>Project</Label>
            <Select
              value={values.selectedProjectId || "__none__"}
              onValueChange={(v) => set("selectedProjectId", v === "__none__" ? "" : v)}
            >
              <SelectTrigger id={`${idPrefix}-project`}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {filteredProjects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-timeout`}>Timeout (seconds)</Label>
        <Input
          id={`${idPrefix}-timeout`}
          type="number"
          value={values.timeout}
          onChange={(e) => set("timeout", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>Permission mode</Label>
        <PermissionModeSelect
          value={values.permissionMode}
          onChange={(v) => set("permissionMode", v)}
          inheritLabel="inherit from project / workspace"
        />
      </div>

      {!hideIsolation && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
          <input
            id={`${idPrefix}-isolate`}
            type="checkbox"
            className="mt-1"
            checked={values.isolateWorktree}
            onChange={(e) => set("isolateWorktree", e.target.checked)}
          />
          <Label
            htmlFor={`${idPrefix}-isolate`}
            className="cursor-pointer"
          >
            <div className="font-medium">Run in isolated git worktree</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Creates a fresh branch (<code>flockctl/task-&lt;id&gt;</code>)
              and worktree under <code>.flockctl/worktrees/</code> so this
              task's edits can't collide with parallel runs. Requires the
              project to be a git repo with at least one commit; falls
              back silently to the shared cwd otherwise.
            </div>
          </Label>
        </div>
      )}
    </>
  );
}
