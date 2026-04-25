import { useMemo, useState } from "react";
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useProjects,
  useWorkspaces,
} from "@/lib/hooks";
import { formatTime } from "@/lib/format";
import type { TaskTemplate, TaskTemplateCreate, TemplateScope } from "@/lib/types";
import { templateKey } from "@/lib/types";
import type { TemplateFilter, TemplateRef } from "@/lib/api";
import { TaskFormFields, defaultTaskFormValues } from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

const PAGE_SIZE = 20;

type ScopeFilter = "all" | TemplateScope;

function scopeLabel(s: TemplateScope): string {
  return s === "global" ? "Global" : s === "workspace" ? "Workspace" : "Project";
}

function CreateTemplateDialog({
  defaultScope,
  defaultWorkspaceId,
  defaultProjectId,
  lockScope,
  triggerLabel,
  triggerSize,
}: {
  defaultScope?: TemplateScope;
  defaultWorkspaceId?: string;
  defaultProjectId?: string;
  lockScope?: boolean;
  triggerLabel?: string;
  triggerSize?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<TemplateScope>(defaultScope ?? "global");
  const [workspaceId, setWorkspaceId] = useState<string>(defaultWorkspaceId ?? "");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formValues, setFormValues] = useState<TaskFormValues>(defaultTaskFormValues);
  const [formError, setFormError] = useState("");

  const { data: workspacesList } = useWorkspaces();
  const { data: projectsList } = useProjects();
  const createTemplate = useCreateTemplate();

  function resetForm() {
    setScope(defaultScope ?? "global");
    setWorkspaceId(defaultWorkspaceId ?? "");
    setProjectId(defaultProjectId ?? "");
    setName("");
    setDescription("");
    setFormValues(defaultTaskFormValues);
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }
    if (scope === "workspace" && !workspaceId) {
      setFormError("Workspace is required for workspace-scoped templates.");
      return;
    }
    if (scope === "project" && !projectId) {
      setFormError("Project is required for project-scoped templates.");
      return;
    }

    const data: TaskTemplateCreate = {
      name: trimmedName,
      scope,
      timeout_seconds: Number(formValues.timeout) || 300,
    };
    if (scope === "workspace") data.workspace_id = workspaceId;
    if (scope === "project") data.project_id = projectId;
    if (description.trim()) data.description = description.trim();
    if (formValues.agent.trim()) data.agent = formValues.agent.trim();
    if (formValues.model.trim() && formValues.model !== "__default__") {
      data.model = formValues.model.trim();
    }
    if (formValues.prompt.trim()) data.prompt = formValues.prompt.trim();

    try {
      await createTemplate.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create template");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        <Button size={triggerSize}>{triggerLabel ?? "Create Template"}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Template</DialogTitle>
          <DialogDescription>
            Define a reusable task template. Name and scope are required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tpl-scope">Scope *</Label>
            <Select
              value={scope}
              onValueChange={(v) => {
                if (lockScope) return;
                setScope(v as TemplateScope);
                if (v !== "workspace") setWorkspaceId("");
                if (v !== "project") setProjectId("");
              }}
              disabled={lockScope}
            >
              <SelectTrigger id="tpl-scope">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="workspace">Workspace</SelectItem>
                <SelectItem value="project">Project</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scope === "workspace" && (
            <div className="space-y-2">
              <Label htmlFor="tpl-workspace">Workspace *</Label>
              <Select
                value={workspaceId}
                onValueChange={setWorkspaceId}
                disabled={lockScope && !!defaultWorkspaceId}
              >
                <SelectTrigger id="tpl-workspace">
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {(workspacesList ?? []).map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === "project" && (
            <div className="space-y-2">
              <Label htmlFor="tpl-project">Project *</Label>
              <Select
                value={projectId}
                onValueChange={setProjectId}
                disabled={lockScope && !!defaultProjectId}
              >
                <SelectTrigger id="tpl-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {(projectsList ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="tpl-name">Name *</Label>
            <Input
              id="tpl-name"
              placeholder="e.g. nightly-build"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-description">Description</Label>
            <Textarea
              id="tpl-description"
              placeholder="What this template does..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <TaskFormFields
            values={formValues}
            onChange={setFormValues}
            idPrefix="tpl"
            hideAgent
            hideWorkspaceProject
            keyBeforeModel
          />
          <p className="text-xs text-muted-foreground">
            Note: AI key is configured per schedule, not on the template.
          </p>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createTemplate.isPending}>
              {createTemplate.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditTemplateDialog({
  template,
  onClose,
}: {
  template: TaskTemplate;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(template.description ?? "");
  const [formValues, setFormValues] = useState<TaskFormValues>({
    agent: template.agent ?? "",
    model: template.model ?? "__default__",
    prompt: template.prompt ?? "",
    timeout: String(template.timeout_seconds ?? 300),
    assignedKeyId: "__auto__",
    selectedWorkspaceId: template.workspace_id ?? "",
    selectedProjectId: template.project_id ?? "",
    permissionMode: null,
  });
  const [formError, setFormError] = useState("");

  const updateTemplate = useUpdateTemplate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const data: Partial<TaskTemplateCreate> = {
      description: description.trim() || null,
      agent: formValues.agent.trim() || null,
      model:
        formValues.model.trim() && formValues.model !== "__default__"
          ? formValues.model.trim()
          : null,
      prompt: formValues.prompt.trim() || null,
      timeout_seconds: Number(formValues.timeout) || 300,
    };

    const ref: TemplateRef = {
      scope: template.scope,
      name: template.name,
      workspaceId: template.workspace_id ?? null,
      projectId: template.project_id ?? null,
    };

    try {
      await updateTemplate.mutateAsync({ ref, data });
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update template");
    }
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit Template</DialogTitle>
        <DialogDescription>
          Update template fields. Name and scope are immutable.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="edit-tpl-scope">Scope</Label>
            <Input id="edit-tpl-scope" value={scopeLabel(template.scope)} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-tpl-name">Name</Label>
            <Input id="edit-tpl-name" value={template.name} disabled />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-tpl-description">Description</Label>
          <Textarea
            id="edit-tpl-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <TaskFormFields
          values={formValues}
          onChange={setFormValues}
          idPrefix="edit-tpl"
          hideAgent
          hideWorkspaceProject
          keyBeforeModel
        />
        <p className="text-xs text-muted-foreground">
          Note: AI key is configured per schedule, not on the template.
        </p>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button type="submit" disabled={updateTemplate.isPending}>
            {updateTemplate.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export default function TemplatesPage() {
  const [offset, setOffset] = useState(0);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("");
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskTemplate | null>(null);

  const filter: TemplateFilter = useMemo(() => {
    const f: TemplateFilter = {};
    if (scopeFilter !== "all") f.scope = scopeFilter;
    if (scopeFilter === "workspace" && workspaceFilter) f.workspaceId = workspaceFilter;
    if (scopeFilter === "project" && projectFilter) f.projectId = projectFilter;
    return f;
  }, [scopeFilter, workspaceFilter, projectFilter]);

  const { data, isLoading, error } = useTemplates(offset, PAGE_SIZE, filter);
  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();
  const deleteTemplateMutation = useDeleteTemplate();
  const deleteConfirm = useConfirmDialog();

  const projectById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsList ?? []) m.set(String(p.id), p.name);
    return m;
  }, [projectsList]);
  const workspaceById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspacesList ?? []) m.set(String(w.id), w.name);
    return m;
  }, [workspacesList]);

  const showingFrom = data ? Math.min(offset + 1, data.total) : 0;
  const showingTo = data ? Math.min(offset + PAGE_SIZE, data.total) : 0;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold sm:text-2xl">Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Manage reusable task templates scoped to global, workspace, or project.
          </p>
        </div>
        <CreateTemplateDialog />
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Scope</Label>
          <Select
            value={scopeFilter}
            onValueChange={(v) => {
              setScopeFilter(v as ScopeFilter);
              setOffset(0);
              setWorkspaceFilter("");
              setProjectFilter("");
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="global">Global</SelectItem>
              <SelectItem value="workspace">Workspace</SelectItem>
              <SelectItem value="project">Project</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {scopeFilter === "workspace" && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Workspace</Label>
            <Select
              value={workspaceFilter || "__all__"}
              onValueChange={(v) => {
                setWorkspaceFilter(v === "__all__" ? "" : v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="All workspaces" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All workspaces</SelectItem>
                {(workspacesList ?? []).map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {scopeFilter === "project" && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Project</Label>
            <Select
              value={projectFilter || "__all__"}
              onValueChange={(v) => {
                setProjectFilter(v === "__all__" ? "" : v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All projects</SelectItem>
                {(projectsList ?? []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="mt-6">
        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-destructive">
            Failed to load templates: {error.message}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">No templates yet.</p>
        )}
        {data && data.items.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Showing {showingFrom}–{showingTo} of {data.total} template
              {data.total !== 1 ? "s" : ""}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden sm:table-cell">Scope</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden lg:table-cell">Description</TableHead>
                  <TableHead className="hidden md:table-cell">Workspace</TableHead>
                  <TableHead className="hidden md:table-cell">Project</TableHead>
                  <TableHead className="hidden xl:table-cell">Timeout</TableHead>
                  <TableHead className="hidden sm:table-cell">Updated</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((tpl: TaskTemplate) => {
                  const wsName = tpl.workspace_id
                    ? workspaceById.get(String(tpl.workspace_id)) ?? `#${tpl.workspace_id}`
                    : null;
                  const projName = tpl.project_id
                    ? projectById.get(String(tpl.project_id)) ?? `#${tpl.project_id}`
                    : null;
                  return (
                    <TableRow key={templateKey(tpl)}>
                      <TableCell className="hidden text-xs sm:table-cell">{scopeLabel(tpl.scope)}</TableCell>
                      <TableCell className="font-medium">{tpl.name}</TableCell>
                      <TableCell className="hidden max-w-[200px] truncate text-sm text-muted-foreground lg:table-cell">
                        {tpl.description ?? "-"}
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">
                        {wsName ?? <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">
                        {projName ?? <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="hidden text-xs xl:table-cell">
                        {tpl.timeout_seconds != null ? `${tpl.timeout_seconds}s` : "-"}
                      </TableCell>
                      <TableCell className="hidden text-xs sm:table-cell">
                        {formatTime(tpl.updated_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setEditingTemplate(tpl)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            disabled={deleteTemplateMutation.isPending}
                            onClick={() => {
                              setDeleteTarget(tpl);
                              deleteConfirm.requestConfirm(templateKey(tpl));
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {/* Pagination */}
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
                {Math.ceil(data.total / PAGE_SIZE)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <Dialog open={!!editingTemplate} onOpenChange={(v) => { if (!v) setEditingTemplate(null); }}>
        {editingTemplate && (
          <EditTemplateDialog template={editingTemplate} onClose={() => setEditingTemplate(null)} />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(v) => {
          deleteConfirm.onOpenChange(v);
          if (!v) setDeleteTarget(null);
        }}
        title="Delete Template"
        description="This will permanently delete this template. Any schedules referencing it will stop working. This action cannot be undone."
        isPending={deleteTemplateMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            const ref: TemplateRef = {
              scope: deleteTarget.scope,
              name: deleteTarget.name,
              workspaceId: deleteTarget.workspace_id ?? null,
              projectId: deleteTarget.project_id ?? null,
            };
            deleteTemplateMutation.mutate(ref, {
              onSuccess: () => {
                deleteConfirm.reset();
                setDeleteTarget(null);
              },
            });
          }
        }}
      />
    </div>
  );
}

export { CreateTemplateDialog };
