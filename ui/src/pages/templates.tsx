import { useEffect, useMemo, useState } from "react";
import { useTemplates, useCreateTemplate, useUpdateTemplate, useDeleteTemplate, useProjects, useWorkspaces, useAIKeys } from "@/lib/hooks";
import type { TaskTemplate, TaskTemplateCreate } from "@/lib/types";
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function CreateTemplateDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formValues, setFormValues] = useState<TaskFormValues>(defaultTaskFormValues);
  const [formError, setFormError] = useState("");

  const createTemplate = useCreateTemplate();

  function resetForm() {
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

    const data: TaskTemplateCreate = {
      name: trimmedName,
      timeout_seconds: Number(formValues.timeout) || 300,
    };
    if (description.trim()) data.description = description.trim();
    if (formValues.agent.trim()) data.agent = formValues.agent.trim();
    if (formValues.model.trim() && formValues.model !== "__default__") data.model = formValues.model.trim();
    if (formValues.prompt.trim()) data.prompt = formValues.prompt.trim();
    if (formValues.selectedProjectId && formValues.selectedProjectId !== "__none__") data.project_id = formValues.selectedProjectId;
    if (formValues.assignedKeyId && formValues.assignedKeyId !== "__auto__") data.assigned_key_id = formValues.assignedKeyId;

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
        <Button>Create Template</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Template</DialogTitle>
          <DialogDescription>
            Define a reusable task template. Name is required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
          <TaskFormFields values={formValues} onChange={setFormValues} idPrefix="tpl" />
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

function EditTemplateDialog({ template, onClose }: { template: TaskTemplate; onClose: () => void }) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [formValues, setFormValues] = useState<TaskFormValues>({
    agent: template.agent ?? "",
    model: template.model ?? "__default__",
    prompt: template.prompt ?? "",
    timeout: String(template.timeout_seconds),
    assignedKeyId: template.assigned_key_id ?? "__auto__",
    selectedWorkspaceId: "",
    selectedProjectId: template.project_id ?? "",
    permissionMode: null,
  });
  const [formError, setFormError] = useState("");

  const { data: projectsList } = useProjects();
  const updateTemplate = useUpdateTemplate();

  useEffect(() => {
    if (!template.project_id || !projectsList) return;
    const project = projectsList.find((p) => String(p.id) === template.project_id);
    if (project?.workspace_id != null) {
      setFormValues((v) =>
        v.selectedWorkspaceId ? v : { ...v, selectedWorkspaceId: String(project.workspace_id) },
      );
    }
  }, [template.project_id, projectsList]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }

    const data: Partial<TaskTemplateCreate> = {
      name: trimmedName,
      description: description.trim() || null,
      agent: formValues.agent.trim() || null,
      model: (formValues.model.trim() && formValues.model !== "__default__") ? formValues.model.trim() : null,
      prompt: formValues.prompt.trim() || null,
      timeout_seconds: Number(formValues.timeout) || 300,
      project_id: (formValues.selectedProjectId && formValues.selectedProjectId !== "__none__") ? formValues.selectedProjectId : null,
      assigned_key_id: (formValues.assignedKeyId && formValues.assignedKeyId !== "__auto__") ? formValues.assignedKeyId : null,
    };

    try {
      await updateTemplate.mutateAsync({ id: template.id, data });
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update template");
    }
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit Template</DialogTitle>
        <DialogDescription>Update template fields. Name is required.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="edit-tpl-name">Name *</Label>
          <Input id="edit-tpl-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-tpl-description">Description</Label>
          <Textarea id="edit-tpl-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </div>
        <TaskFormFields values={formValues} onChange={setFormValues} idPrefix="edit-tpl" />
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
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const { data, isLoading, error } = useTemplates(offset, PAGE_SIZE);
  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();
  const { data: aiKeysList } = useAIKeys();
  const deleteTemplateMutation = useDeleteTemplate();
  const deleteConfirm = useConfirmDialog();

  const projectById = useMemo(() => {
    const m = new Map<string, { name: string; workspace_id: number | null }>();
    for (const p of projectsList ?? []) m.set(String(p.id), { name: p.name, workspace_id: p.workspace_id });
    return m;
  }, [projectsList]);
  const workspaceById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspacesList ?? []) m.set(String(w.id), w.name);
    return m;
  }, [workspacesList]);
  const keyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const k of aiKeysList ?? []) m.set(String(k.id), k.name ?? k.label ?? `Key #${k.id}`);
    return m;
  }, [aiKeysList]);

  const showingFrom = data ? Math.min(offset + 1, data.total) : 0;
  const showingTo = data ? Math.min(offset + PAGE_SIZE, data.total) : 0;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Templates</h1>
          <p className="mt-1 text-muted-foreground">
            Manage reusable task templates.
          </p>
        </div>
        <CreateTemplateDialog />
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
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>AI Key</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Timeout</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((tpl: TaskTemplate) => {
                  const project = tpl.project_id ? projectById.get(tpl.project_id) : null;
                  const workspaceName = project?.workspace_id != null
                    ? workspaceById.get(String(project.workspace_id)) ?? `#${project.workspace_id}`
                    : null;
                  const keyName = tpl.assigned_key_id ? keyById.get(tpl.assigned_key_id) : null;
                  return (
                  <TableRow key={tpl.id}>
                    <TableCell className="font-medium">{tpl.name}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                      {tpl.description ?? "-"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {keyName ?? <span className="text-muted-foreground">Auto</span>}
                    </TableCell>
                    <TableCell className="text-sm">{workspaceName ?? <span className="text-muted-foreground">-</span>}</TableCell>
                    <TableCell className="text-sm">{project?.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
                    <TableCell className="text-xs">{tpl.timeout_seconds}s</TableCell>
                    <TableCell className="text-xs">
                      {formatTime(tpl.created_at)}
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
                          onClick={() => deleteConfirm.requestConfirm(tpl.id)}
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
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Template"
        description="This will permanently delete this template. Any schedules using it will stop working. This action cannot be undone."
        isPending={deleteTemplateMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteTemplateMutation.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
