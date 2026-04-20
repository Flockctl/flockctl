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
import { useMeta, useAIKeys, useProjects, useWorkspaces } from "@/lib/hooks";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import type { PermissionMode } from "@/lib/types";

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
}

export function TaskFormFields({ values, onChange, idPrefix }: TaskFormFieldsProps) {
  const { data: meta } = useMeta();
  const { data: aiKeys } = useAIKeys();
  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();

  const agents = meta?.agents?.filter(a => a.available) ?? [];
  const models = meta?.models ?? [];
  const keys = (aiKeys ?? []).filter(k => k.is_active);

  const filteredProjects = values.selectedWorkspaceId
    ? (projectsList ?? []).filter(p => String(p.workspace_id) === values.selectedWorkspaceId)
    : (projectsList ?? []);

  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <>
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

      <div className="grid grid-cols-2 gap-4">
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
