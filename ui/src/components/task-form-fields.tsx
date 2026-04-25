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
};

interface TaskFormFieldsProps {
  values: TaskFormValues;
  onChange: (values: TaskFormValues) => void;
  /** Prefix for input IDs to avoid collisions when multiple forms exist */
  idPrefix: string;
  /** Hide the Agent selector (templates don't carry an agent binding today). */
  hideAgent?: boolean;
  /** Hide the Workspace/Project row — templates carry their own scope binding. */
  hideWorkspaceProject?: boolean;
  /** Render AI Key above Model instead of the default (Model → AI Key) order. */
  keyBeforeModel?: boolean;
}

export function TaskFormFields({
  values,
  onChange,
  idPrefix,
  hideAgent = false,
  hideWorkspaceProject = false,
  keyBeforeModel = false,
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

  return (
    <>
      {agentField}

      {keyBeforeModel ? (
        <>
          {keyField}
          {modelField}
        </>
      ) : (
        <>
          {modelField}
          {keyField}
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
    </>
  );
}
