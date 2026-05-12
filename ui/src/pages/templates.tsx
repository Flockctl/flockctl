import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileCode2, Plus } from "lucide-react";

import {
  useTemplates,
  useUpdateTemplate,
  useDeleteTemplate,
  useCreateChat,
} from "@/lib/hooks";
import type { TaskTemplate, TaskTemplateCreate, TemplateScope } from "@/lib/types";
import { templateKey } from "@/lib/types";
import type { TemplateRef } from "@/lib/api";
import { TaskFormFields } from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
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
} from "@/components/ui/dialog";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "@/components/design";
import { slugify } from "@/lib/utils";

import {
  TemplatesToolbar,
  filterTemplatesByTag,
  filterTemplatesByQuery,
  type TemplatesToolbarTag,
} from "./templates-components/TemplatesToolbar";
import {
  TemplateCard,
  type TemplateCardData,
} from "./templates-components/TemplateCard";
import { NewTemplateDialog } from "./templates-components/NewTemplateDialog";

/**
 * `/templates` page assembly (slice
 * `25-ui-redesign-library-surfaces/00-templates` T03).
 *
 * Composes the M22+ flat-primitive widgets prior tasks built in
 * isolation:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ <SectionHeader title="Templates" subtitle="N templates"          │
 *   │   action={<button>+ New template</button>} />                    │
 *   │ <TemplatesToolbar totalCount tags onTagChange />                 │
 *   │                                                                  │
 *   │ grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 of               │
 *   │   <TemplateCard onOpenInChat onClick=open-edit />                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Search lives in the global ⌘K palette; the per-page search input
 * was removed in favour of a single global search surface.  The
 * `+ New template` CTA sits in the `SectionHeader` action slot to
 * match the projects / chats / workspaces convention.
 *
 * State plumbing:
 *
 *   - `?tag=`   — owned by the toolbar; mirrored via `onTagChange`.
 *
 * Tag derivation:
 *   The wire-level `TaskTemplate` row does NOT carry a `tags` field
 *   (templates are file-backed). For the redesign we derive tags from
 *   the row's structural fields — `scope` is always present, `agent`
 *   and `model` (when set) become additional tag chips. This keeps the
 *   tag-chip contract honest (every distinct tag corresponds to
 *   something filterable) without inventing a new server contract.
 *
 * Open in chat:
 *   The footer button creates a new chat seeded with the template's
 *   scope/workspace/project metadata and navigates to it. The chat is
 *   the entry point for instantiating the template — turning a saved
 *   recipe into a live conversation.
 */

const CARDS_GRID_CLASSES =
  "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3";

function scopeLabel(s: TemplateScope): string {
  return s === "global" ? "Global" : s === "workspace" ? "Workspace" : "Project";
}

/**
 * Derive a card's tag list from the underlying `TaskTemplate` row.
 *
 * We deliberately keep the surface tiny (scope + agent + a model token)
 * so the chip row never explodes past the visible band. Tags are
 * lower-cased to match the toolbar's case-insensitive predicate.
 */
function deriveTags(t: TaskTemplate): string[] {
  const tags: string[] = [t.scope];
  if (t.agent && t.agent.trim()) tags.push(t.agent.trim().toLowerCase());
  if (t.model && t.model.trim()) {
    // Strip vendor prefix + date suffix so the chip stays short
    // ("claude-sonnet-4-20250514" → "sonnet"). Falls back to the raw
    // string when no canonical token is recognised.
    const m = t.model.toLowerCase();
    if (m.includes("opus")) tags.push("opus");
    else if (m.includes("sonnet")) tags.push("sonnet");
    else if (m.includes("haiku")) tags.push("haiku");
  }
  return Array.from(new Set(tags));
}

/**
 * Adapter from the wire row to the {@link TemplateCardData} props bag
 * the card consumes. Centralised here so the card stays presentation-
 * only (no react-query, no domain quirks).
 */
function toCardData(t: TaskTemplate): TemplateCardData {
  return {
    key: templateKey(t),
    name: t.name,
    description: t.description,
    tags: deriveTags(t),
    lastUsedAt: t.updated_at,
  };
}

/**
 * Edit dialog — mirrors the legacy in-page form. Kept here (not lifted
 * into a separate file) because it's only mounted on the templates
 * page and the legacy table view also relied on this exact form.
 */
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
    isolateWorktree: template.isolation === "worktree",
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
      // Round-trip the worktree-isolation flag — `null` clears the
      // template-level default when the operator unchecks the box,
      // matching the wider "PATCH must be honest about clears" rule.
      isolation: formValues.isolateWorktree ? "worktree" : null,
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
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit Template</DialogTitle>
        <DialogDescription>
          Update template fields. Name and scope are immutable.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-3">
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
          hideModel
          hideKey
          hideWorkspaceProject
          keyBeforeModel
        />
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
  const navigate = useNavigate();

  // URL-backed filter state (audit-round-3 fix). The toolbar's tag chip
  // and search input now read from / write to `useSearchParams`, so:
  //   - refresh / deep-link preserves the active filter
  //   - the back button correctly walks through filter history
  //   - bookmarks reproduce the exact filtered view
  //
  // The previous `useState` shape silently dropped the filter on every
  // reload — inconsistent with `/tasks`, which uses the same pattern.
  const [searchParams, setSearchParams] = useSearchParams();
  const tag = searchParams.get("tag") ?? "all";
  const query = searchParams.get("q") ?? "";

  const setTag = (next: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (!next || next === "all") sp.delete("tag");
      else sp.set("tag", next);
      return sp;
    });
  };
  const setQuery = (next: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (!next) sp.delete("q");
      else sp.set("q", next);
      return sp;
    });
  };

  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskTemplate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Fetch a generous page (200) — templates are typically dozens, not
  // thousands; a single round-trip lets the page filter / search /
  // group entirely client-side without per-keystroke refetches.
  const { data, isLoading, error } = useTemplates(0, 200, {});
  const deleteTemplateMutation = useDeleteTemplate();
  const deleteConfirm = useConfirmDialog();
  const createChat = useCreateChat();

  const items: TaskTemplate[] = useMemo(() => data?.items ?? [], [data?.items]);

  // Derive the distinct tag set across every template, with counts.
  // The chip row reflects what users can actually filter to — so a tag
  // a single template carries is a valid chip. Sorted alphabetically so
  // chip order is stable across renders.
  const tags: TemplatesToolbarTag[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of items) {
      for (const tag of deriveTags(t)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({
        id: name,
        slug: slugify(name),
        name,
        count,
      }));
  }, [items]);

  const slugToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tags) m.set(t.slug, t.name);
    return m;
  }, [tags]);

  // Apply the tag predicate the toolbar contracts for, then narrow by
  // the search query. Both helpers are exported from the toolbar so the
  // chip row, the search input, and the grid can never disagree on
  // what's visible.
  const filtered = useMemo(() => {
    const withTags = items.map((t) => ({
      template: t,
      tags: deriveTags(t),
    }));
    // Toolbar's tag setter writes the slug — translate back to the raw
    // tag value before matching.
    const tagValue = tag === "all" ? "all" : slugToName.get(tag) ?? tag;
    const byTag = filterTemplatesByTag(withTags, tagValue).map(
      (r) => r.template,
    );
    return filterTemplatesByQuery(byTag, query);
  }, [items, tag, slugToName, query]);

  // Render-time guards — mutually exclusive states.
  const showLoading = isLoading;
  const showError = !!error;
  const showInitialEmpty = !isLoading && !error && items.length === 0;
  const showFilteredEmpty =
    !isLoading && !error && items.length > 0 && filtered.length === 0;
  const showGrid = !isLoading && !error && filtered.length > 0;

  const subtitle =
    isLoading || error
      ? undefined
      : `${items.length} ${items.length === 1 ? "template" : "templates"}`;

  /**
   * Spin up a new chat seeded with the template's scope / workspace /
   * project metadata and navigate to it. The seeded title carries the
   * template name so the chat list shows what's running.
   */
  async function handleOpenInChat(t: TaskTemplate) {
    try {
      const created = await createChat.mutateAsync({
        title: t.name,
        projectId: t.project_id ? Number(t.project_id) : null,
        workspaceId: t.workspace_id ? Number(t.workspace_id) : null,
      });
      const id = (created as { id: string | number }).id;
      navigate(`/chats/${id}`);
    } catch {
      // Swallow — the mutation surfaces its own error UI elsewhere; the
      // user can retry from the same affordance.
    }
  }

  return (
    <div data-testid="templates-page" className="max-w-7xl">
      <SectionHeader
        title="Templates"
        subtitle={subtitle}
        action={
          !showLoading && !showError ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setDialogOpen(true)}
              data-testid="templates-new-template-button"
            >
              <Plus aria-hidden="true" />
              New template
            </Button>
          ) : undefined
        }
      />

      {!showLoading && !showError && (
        <div className="mb-4">
          <TemplatesToolbar
            totalCount={items.length}
            tags={tags}
            onTagChange={setTag}
            onSearchChange={setQuery}
          />
        </div>
      )}

      {showLoading && (
        <div className="space-y-2" data-testid="templates-loading">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {showError && (
        <p className="text-destructive" data-testid="templates-error">
          Failed to load templates: {(error as Error)?.message}
        </p>
      )}

      {showInitialEmpty && (
        <EmptyState
          icon={FileCode2}
          title="No templates yet"
          description="Save a reusable recipe — prompt, model, and tools — to spin up the same task with a single click."
          action={
            <Button
              type="button"
              size="sm"
              onClick={() => setDialogOpen(true)}
              data-testid="templates-empty-cta"
            >
              <Plus aria-hidden="true" />
              New template
            </Button>
          }
          data-testid="templates-empty-state"
        />
      )}

      {showFilteredEmpty && (
        <EmptyState
          icon={FileCode2}
          title="No templates match your filters"
          description="Try clearing the search or picking a different tag."
          data-testid="templates-filtered-empty-state"
        />
      )}

      {showGrid && (
        <div
          data-testid="templates-grid"
          className={CARDS_GRID_CLASSES}
        >
          {filtered.map((t) => (
            <TemplateCard
              key={templateKey(t)}
              template={toCardData(t)}
              onOpenInChat={() => void handleOpenInChat(t)}
              onClick={() => setEditingTemplate(t)}
            />
          ))}
        </div>
      )}

      {/*
        Mount the dialog once per page render — the SectionHeader's
        `+ New template` button drives `dialogOpen` state directly.
      */}
      <NewTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <Dialog
        open={!!editingTemplate}
        onOpenChange={(v) => {
          if (!v) setEditingTemplate(null);
        }}
      >
        {editingTemplate && (
          <EditTemplateDialog
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

/**
 * Backwards-compat re-export so external callers
 * (e.g. `pages/project-detail-components/ProjectTemplatesSection.tsx`)
 * keep working after the redesign. The legacy in-page
 * `CreateTemplateDialog` was a self-contained Dialog with a built-in
 * trigger, identical in shape to the refreshed `NewTemplateDialog`
 * (which now fronts the page). Aliasing them here lets the import in
 * the project-detail tab keep working without any caller-side change.
 */
export { NewTemplateDialog as CreateTemplateDialog };
