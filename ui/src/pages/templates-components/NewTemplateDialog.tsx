import { useState } from "react";
import { Plus } from "lucide-react";

import {
  useCreateTemplate,
  useProjects,
  useWorkspaces,
} from "@/lib/hooks";
import type { TaskTemplateCreate, TemplateScope } from "@/lib/types";
import {
  TaskFormFields,
  defaultTaskFormValues,
} from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
import { Button } from "@/components/ui/button";
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
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetStages,
  BottomSheetTitle,
  BottomSheetTrigger,
  type StagePill,
} from "@/components/design";

/**
 * NewTemplateDialog — bottom-sheet refresh of the create-template flow.
 *
 * Behaviour is preserved verbatim from the prior shadcn-Dialog version:
 * the same scope picker, the same workspace/project dependent dropdowns,
 * the same `useCreateTemplate` mutation, the same `TaskFormFields`
 * (with `hideAgent`, `hideModel`, `hideKey`, `hideWorkspaceProject`,
 * `keyBeforeModel` — Model + AI Key live on Schedules now, not on the
 * template itself; same migration `assigned_key_id` already went
 * through, see commit 2aa6f73 for the rationale).
 *
 * What changed (M27 refresh):
 *
 *   - Surface is `BottomSheet` (slides up from the bottom edge of the
 *     viewport, ~880px wide, centered horizontally). Mirrors the
 *     workspace / project create flows so all four are visually
 *     consistent.
 *   - Stage-pills strip — Identity → Scope → Configuration → Review —
 *     auto-colors from form filled-ness. Visual progress only;
 *     clicking a pill does not navigate.
 *   - Body is a 2-column layout: the legacy 160px-label grid on the
 *     left (preserves the visual fingerprint test asserts on), a
 *     "Summary" sidebar on the right showing the live derived scope
 *     target, agent / model, timeout, and side-effects.
 *
 * Test contract preserved:
 *
 *   - Heading: `Create Template` (matched by `/^Create Template$/`).
 *   - Test IDs: `new-template-trigger`, `new-template-dialog`,
 *     `new-template-form`, `new-template-grid` (with the literal
 *     `grid grid-cols-[160px_1fr]` class string the test asserts on),
 *     `new-template-submit`, `new-template-error`.
 *   - Field IDs: `tpl-scope`, `tpl-workspace`, `tpl-project`,
 *     `tpl-name`, `tpl-description` (+ `tpl-*` prefixed inputs
 *     rendered by `TaskFormFields`).
 *   - Trigger button text — defaults to "Create Template", overridable
 *     via `triggerLabel`.
 *   - Submit button text — `Create` / `Creating…`.
 */

interface NewTemplateDialogProps {
  /** Pre-select a scope and lock the picker (e.g. when launched from a project page). */
  defaultScope?: TemplateScope;
  defaultWorkspaceId?: string;
  defaultProjectId?: string;
  lockScope?: boolean;
  /** Override the trigger button label (defaults to "Create Template"). */
  triggerLabel?: string;
  /** Forward to the trigger button so callers can keep the existing density. */
  triggerSize?: "default" | "sm";
  /**
   * Controlled-open. When provided alongside `onOpenChange`, the sheet
   * lets the parent drive its open state and skips rendering its own
   * trigger button — the parent is responsible for opening it via its
   * own affordance (e.g. the toolbar's `+ New template` chip-button).
   * Pass `undefined` for self-contained mode.
   */
  open?: boolean;
  /** Required when `open` is provided. Fires whenever the sheet opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Single labelled form row — the building block of the grid layout.
 * (Identical to the version that lived here pre-refresh; kept verbatim
 * so callers and styles read the same.)
 */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="pt-2 text-sm font-medium leading-none">
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span>{label}</span>}
      </div>
      <div className="min-w-0 space-y-2">
        {children}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </>
  );
}

export function NewTemplateDialog({
  defaultScope,
  defaultWorkspaceId,
  defaultProjectId,
  lockScope,
  triggerLabel,
  triggerSize,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewTemplateDialogProps = {}) {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? !!controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (isControlled) controlledOnOpenChange?.(v);
    else setInternalOpen(v);
  };
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
    if (formValues.isolateWorktree) data.isolation = "worktree";

    try {
      await createTemplate.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create template");
    }
  }

  // Stage-pills derived from form state. Identity = name. Scope = scope
  // picked AND (workspace/project filled when required). Configuration =
  // any non-default agent/model/prompt picked. Review lights up only
  // when the rest are done.
  const identityDone = name.trim().length > 0;
  const scopeDone =
    scope === "global" ||
    (scope === "workspace" && workspaceId !== "") ||
    (scope === "project" && projectId !== "");
  const configDone =
    formValues.agent.trim().length > 0 ||
    formValues.prompt.trim().length > 0 ||
    (formValues.model.trim().length > 0 && formValues.model !== "__default__");
  const allDone = identityDone && scopeDone;
  const stages: StagePill[] = [
    { label: "Identity", state: identityDone ? "done" : "active" },
    {
      label: "Scope",
      state: !identityDone ? "todo" : scopeDone ? "done" : "active",
      hint: scopeDone ? scope : undefined,
    },
    {
      label: "Configuration",
      state: !identityDone || !scopeDone
        ? "todo"
        : configDone
          ? "done"
          : "active",
    },
    { label: "Review", state: allDone ? "active" : "todo" },
  ];

  // Live-derive scope target name for the summary sidebar.
  const scopeTarget =
    scope === "workspace"
      ? workspacesList?.find((w) => String(w.id) === workspaceId)?.name
      : scope === "project"
        ? projectsList?.find((p) => String(p.id) === projectId)?.name
        : "Global";

  return (
    <BottomSheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      {!isControlled && (
        <BottomSheetTrigger asChild>
          <Button size={triggerSize ?? "sm"} data-testid="new-template-trigger">
            <Plus aria-hidden="true" />
            {triggerLabel ?? "New template"}
          </Button>
        </BottomSheetTrigger>
      )}
      <BottomSheetContent
        className="p-0 sm:max-w-[880px]"
        data-testid="new-template-dialog"
      >
        <BottomSheetHeader className="px-6 pt-2 pb-3">
          <BottomSheetTitle>Create Template</BottomSheetTitle>
          <BottomSheetDescription>
            Define a reusable task template. Name and scope are required.
          </BottomSheetDescription>
        </BottomSheetHeader>

        <BottomSheetStages stages={stages} data-testid="tpl-stages" />

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
          data-testid="new-template-form"
        >
          {/*
            Two-column body: legacy 160px-label grid on the left,
            Summary on the right. The form column carries the inner
            `overflow-y-auto` so any future scroll-baseline e2e (the
            sister workspace dialog has one) finds a real scroll
            container inside `role=dialog`. Summary is hidden below
            `sm:` so narrow viewports keep a usable single-column form.
          */}
          <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_240px]">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
              {/*
                Inner 2-column label/control grid. The class token
                `grid-cols-[160px_1fr]` is the visual fingerprint of the
                M22+ refresh — `templates-new-dialog.test.tsx` asserts on
                the literal class string, so a regression to a
                `space-y-4` stack fails loudly here.
              */}
              <div
                className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-3 items-start"
                data-testid="new-template-grid"
              >
                <Row label="Scope *" htmlFor="tpl-scope">
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
                </Row>

                {scope === "workspace" && (
                  <Row label="Workspace *" htmlFor="tpl-workspace">
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
                          <SelectItem key={w.id} value={String(w.id)}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Row>
                )}

                {scope === "project" && (
                  <Row label="Project *" htmlFor="tpl-project">
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
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Row>
                )}

                <Row label="Name *" htmlFor="tpl-name">
                  <Input
                    id="tpl-name"
                    placeholder="e.g. nightly-build"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Row>

                <Row label="Description" htmlFor="tpl-description">
                  <Textarea
                    id="tpl-description"
                    placeholder="What this template does..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                  />
                </Row>

                {/*
                  TaskFormFields renders its own labelled controls (Prompt,
                  Timeout, Isolation). Model + AI Key are hidden because
                  they live on Schedules now (see commit 2aa6f73 and the
                  parent edit dialogs) — having them on the template
                  would let an author pick a model that the schedule's
                  picker silently overrides on fire. We span both
                  columns: the inner controls already supply labels, so
                  a left-gutter label here would just duplicate them.
                */}
                <div className="col-span-2">
                  <TaskFormFields
                    values={formValues}
                    onChange={setFormValues}
                    idPrefix="tpl"
                    hideAgent
                    hideModel
                    hideKey
                    hideWorkspaceProject
                    keyBeforeModel
                  />
                </div>

                {formError && (
                  <Row label="">
                    <p
                      className="text-sm text-destructive"
                      data-testid="new-template-error"
                    >
                      {formError}
                    </p>
                  </Row>
                )}
              </div>
            </div>

            {/*
              Summary sidebar — visible at sm: and up. Re-derives from
              form state on every render.
            */}
            <aside
              className="hidden border-l border-zinc-200 bg-zinc-50/60 px-4 py-4 sm:flex sm:flex-col dark:border-zinc-800 dark:bg-zinc-900/40"
              aria-label="Summary"
            >
              <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                Summary
              </p>
              <dl className="mt-3 space-y-3 text-[11.5px]">
                <div>
                  <dt className="text-zinc-500">Name</dt>
                  <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {name.trim() || (
                      <span className="text-zinc-400 italic">— empty —</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Scope</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900 capitalize dark:text-zinc-100">
                    {scope}
                  </dd>
                  {scope !== "global" ? (
                    scopeTarget ? (
                      <p className="mt-0.5 truncate text-[10.5px] text-zinc-600 dark:text-zinc-400">
                        {scopeTarget}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[10.5px] text-zinc-400 italic">
                        target pending
                      </p>
                    )
                  ) : null}
                </div>
                <div>
                  <dt className="text-zinc-500">Agent</dt>
                  <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {formValues.agent.trim() || (
                      <span className="text-zinc-400 italic">default</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Timeout</dt>
                  <dd className="mt-0.5 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {Number(formValues.timeout) || 300}s
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Isolation</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {formValues.isolateWorktree ? "git worktree" : "shared cwd"}
                  </dd>
                </div>
              </dl>

              <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                  Side-effects
                </p>
                <ul className="mt-1.5 space-y-1 text-[10.5px] text-zinc-600 dark:text-zinc-400">
                  <li>
                    +1 row in <span className="font-mono">task_templates</span>
                  </li>
                  <li>reusable from any schedule of matching scope</li>
                </ul>
              </div>
            </aside>
          </div>

          <BottomSheetFooter>
            <Button
              type="submit"
              data-testid="new-template-submit"
              disabled={createTemplate.isPending}
            >
              {createTemplate.isPending ? "Creating…" : "Create"}
            </Button>
          </BottomSheetFooter>
        </form>
      </BottomSheetContent>
    </BottomSheet>
  );
}

export default NewTemplateDialog;
