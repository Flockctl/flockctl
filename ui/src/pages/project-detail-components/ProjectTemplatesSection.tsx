import { useState } from "react";
import {
  useTemplates,
  useUpdateTemplate,
  useDeleteTemplate,
} from "@/lib/hooks";
import type { TaskTemplate, TaskTemplateCreate } from "@/lib/types";
import { templateKey } from "@/lib/types";
import type { TemplateRef } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { TaskFormFields } from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
import { CreateTemplateDialog } from "@/pages/templates";

function EditProjectTemplateDialog({
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
            <Label htmlFor="edit-proj-tpl-scope">Scope</Label>
            <Input id="edit-proj-tpl-scope" value="Project" disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-proj-tpl-name">Name</Label>
            <Input id="edit-proj-tpl-name" value={template.name} disabled />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-proj-tpl-description">Description</Label>
          <Textarea
            id="edit-proj-tpl-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <TaskFormFields
          values={formValues}
          onChange={setFormValues}
          idPrefix="edit-proj-tpl"
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

export function ProjectTemplatesSection({ projectId }: { projectId: string }) {
  const { data, isLoading } = useTemplates(0, 100, { scope: "project", projectId });
  const deleteTemplate = useDeleteTemplate();
  const deleteConfirm = useConfirmDialog();
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskTemplate | null>(null);

  const templates: TaskTemplate[] = data?.items ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Templates</h2>
        <CreateTemplateDialog
          defaultScope="project"
          defaultProjectId={projectId}
          lockScope
          triggerLabel="Create Template"
          triggerSize="sm"
        />
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {!isLoading && templates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No project-scoped templates yet.
        </p>
      )}

      {!isLoading && templates.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Timeout</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-[140px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((tpl) => (
              <TableRow key={templateKey(tpl)}>
                <TableCell className="font-medium">{tpl.name}</TableCell>
                <TableCell className="max-w-[240px] truncate text-sm text-muted-foreground">
                  {tpl.description ?? "\u2014"}
                </TableCell>
                <TableCell className="text-xs">{tpl.model ?? "\u2014"}</TableCell>
                <TableCell className="text-xs">
                  {tpl.timeout_seconds != null ? `${tpl.timeout_seconds}s` : "\u2014"}
                </TableCell>
                <TableCell className="text-xs">{formatTime(tpl.updated_at)}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
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
                      disabled={deleteTemplate.isPending}
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
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={!!editingTemplate}
        onOpenChange={(v) => {
          if (!v) setEditingTemplate(null);
        }}
      >
        {editingTemplate && (
          <EditProjectTemplateDialog
            template={editingTemplate}
            onClose={() => setEditingTemplate(null)}
          />
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
        isPending={deleteTemplate.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            const ref: TemplateRef = {
              scope: deleteTarget.scope,
              name: deleteTarget.name,
              workspaceId: deleteTarget.workspace_id ?? null,
              projectId: deleteTarget.project_id ?? null,
            };
            deleteTemplate.mutate(ref, {
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
