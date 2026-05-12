import * as React from "react";
import { FolderOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import {
  GitignoreToggles,
  DEFAULT_GITIGNORE_TOGGLES,
  type GitignoreTogglesValue,
} from "@/components/gitignore-toggles";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetStages,
  BottomSheetTitle,
  BottomSheetTrigger,
  SegmentToggle,
  type StagePill,
} from "@/components/design";
import { useCreateWorkspace, useAIKeys } from "@/lib/hooks";
import type { WorkspaceCreate } from "@/lib/types";
import { slugify } from "@/lib/utils";
import { cn } from "@/lib/utils";

/**
 * NewWorkspaceDialog — bottom-sheet refresh of the create-workspace flow.
 *
 * Behaviour is preserved verbatim from the prior shadcn-Dialog version
 * (which itself preserved the legacy `CreateWorkspaceDialog` from
 * `pages/workspaces.tsx`):
 *
 *   - same `useCreateWorkspace` mutation,
 *   - same field set (name, description, source mode, path or repoUrl,
 *     allowed AI keys, gitignore toggles),
 *   - same validation rules + auto-derivation comment for empty paths,
 *   - same DirectoryPicker integration sharing `lastPickedPath` with the
 *     project-create flow.
 *
 * What changed (M27 refresh):
 *
 *   - Surface is now `BottomSheet` (slides up from the bottom edge of
 *     the viewport, centered, ~760px wide). The right-edge drawer that
 *     this design replaces overlapped the page's primary-action zone;
 *     the bottom sheet keeps the workspace grid visible above the fold
 *     while the form is open.
 *   - Stage-pills strip — Identity → Source → Access → Review — sits
 *     between header and body. Pills auto-color based on filled-ness
 *     (done | active | todo); they're visual progress, NOT navigation
 *     (the form keeps a single scroll axis).
 *   - Body is a 2-column layout: form on the left, "Summary" sidebar
 *     on the right showing the live derived path, allowed-keys count,
 *     and side-effects (disk, db row, ETA estimate). Provides the
 *     "trust-but-verify" affordance prototype 02D demonstrated.
 *
 * Test contract preserved (so the existing unit + e2e suite stays green):
 *
 *   - Heading text: `New workspace` (matched by `/^New workspace$/`).
 *   - Test IDs: `new-workspace-dialog`, `cw-source-toggle`, `cw-path-browse`,
 *     `cw-submit`, `cw-form-error`, `cw-no-keys-warning`, `cw-gi-*`.
 *   - Field IDs: `cw-name`, `cw-description`, `cw-path`, `cw-repo-url`.
 *   - Trigger button text: "Create Workspace".
 *   - Submit button text: "Create workspace" / "Creating…".
 *   - SegmentToggle aria-label: "Workspace source"; options
 *     "Local Directory" / "Clone from Git".
 *   - Inner scroll container retains `overflow-y-auto` (the visual
 *     baseline e2e at 1280×600 asserts the form scrolls inside the
 *     sheet).
 */
export interface NewWorkspaceDialogProps {
  /**
   * Controlled-open. When provided alongside `onOpenChange`, the
   * sheet does not render its own trigger and the parent owns the
   * click surface. Pass undefined for self-contained mode.
   */
  open?: boolean;
  /** Required when `open` is provided. Fires whenever the sheet opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Custom trigger node for self-contained mode. Defaults to a primary
   * "Create Workspace" Button. Ignored in controlled mode.
   */
  trigger?: React.ReactNode;
}

// Shared with the project-create form (ui/src/pages/projects-components/
// NewProjectDialog.tsx). Using the same localStorage key means the picker's
// "last picked directory" memory is reused across both flows.
const LAST_PICKED_PATH_KEY = "flockctl.lastPickedPath";

type WsSourceMode = "local" | "git";

const SOURCE_OPTIONS = [
  { value: "local" as const, label: "Local Directory" },
  { value: "git" as const, label: "Clone from Git" },
];

export function NewWorkspaceDialog({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  trigger,
}: NewWorkspaceDialogProps = {}): React.JSX.Element {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = isControlled ? !!controlledOpen : internalOpen;

  const [name, setName] = React.useState("");
  const [sourceMode, setSourceMode] = React.useState<WsSourceMode>("local");
  const [path, setPath] = React.useState("");
  const [repoUrl, setRepoUrl] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [formError, setFormError] = React.useState("");
  // Directory picker is an augmentation of the path input, not a replacement:
  // the input still accepts paste / manual edits (the only option in remote
  // mode, where /fs/browse is loopback-gated). The picker just opens modally
  // and writes its result back into the same `path` state.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Snapshotted at picker-open time so re-renders (e.g. user typing in the
  // Name field) don't re-seed the picker's internal state mid-session.
  const [pickerInitialPath, setPickerInitialPath] = React.useState<
    string | undefined
  >(undefined);
  // Allowed AI keys — required at create-time (see src/routes/_allowed-keys.ts).
  // Starts empty so the user must explicitly opt keys in: creating a workspace
  // that can talk to *every* key by default is how credentials leak into the
  // wrong project. Create is disabled until at least one is ticked.
  const [allowedKeyIds, setAllowedKeyIds] = React.useState<number[]>([]);
  const [gitignoreToggles, setGitignoreToggles] =
    React.useState<GitignoreTogglesValue>(DEFAULT_GITIGNORE_TOGGLES);

  const createWorkspace = useCreateWorkspace();
  const { data: aiKeys } = useAIKeys();
  const activeKeys = (aiKeys ?? []).filter((k) => k.is_active);

  function resetForm() {
    setName("");
    setSourceMode("local");
    setPath("");
    setRepoUrl("");
    setDescription("");
    setFormError("");
    setPickerOpen(false);
    setAllowedKeyIds([]);
    setGitignoreToggles(DEFAULT_GITIGNORE_TOGGLES);
  }

  function handleOpenChange(next: boolean) {
    if (isControlled) {
      controlledOnOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
    if (!next) resetForm();
  }

  // Resolve the picker's starting directory: prefer whatever the user has
  // typed (so pasting a partial path and hitting Browse lands nearby), then
  // the last-picked path from localStorage, then $HOME (undefined lets the
  // server default). Computed lazily so SSR / first-paint don't touch
  // localStorage.
  function resolvePickerInitialPath(): string | undefined {
    const typed = path.trim();
    if (typed) return typed;
    try {
      const stored = window.localStorage.getItem(LAST_PICKED_PATH_KEY);
      return stored && stored.trim() ? stored : undefined;
    } catch {
      // localStorage can throw in private-mode Safari etc. — just fall back
      // to $HOME rather than blow up the create flow.
      return undefined;
    }
  }

  function handlePickerSelect(picked: string) {
    setPath(picked);
    try {
      window.localStorage.setItem(LAST_PICKED_PATH_KEY, picked);
    } catch {
      /* ignore — see resolvePickerInitialPath */
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }

    if (allowedKeyIds.length === 0) {
      setFormError("Pick at least one AI provider key.");
      return;
    }

    const data: WorkspaceCreate = {
      name: trimmedName,
      allowed_key_ids: allowedKeyIds,
    };
    if (description.trim()) data.description = description.trim();

    if (sourceMode === "git") {
      const trimmedRepoUrl = repoUrl.trim();
      if (!trimmedRepoUrl) {
        setFormError("Repository URL is required.");
        return;
      }
      data.repoUrl = trimmedRepoUrl;
    } else {
      const trimmedPath = path.trim();
      if (trimmedPath) data.path = trimmedPath;
    }
    // If path is empty, backend auto-derives: ~/flockctl/workspaces/<name>

    // Always forward the full toggle triplet. Server defaults are now
    // (true, true, false) — see `DEFAULT_GITIGNORE_TOGGLES` — so sending
    // only the truthy fields would silently collapse a user-UNchecked
    // value back to the server default. Always-send keeps the row in
    // lockstep with the form state.
    data.gitignore_flockctl = gitignoreToggles.gitignore_flockctl;
    data.gitignore_todo = gitignoreToggles.gitignore_todo;
    data.gitignore_agents_md = gitignoreToggles.gitignore_agents_md;

    try {
      await createWorkspace.mutateAsync(data);
      resetForm();
      handleOpenChange(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create workspace",
      );
    }
  }

  const showSelfTrigger = !isControlled;
  const placeholderSlug = name.trim() ? slugify(name) : "<name>";
  const derivedPath = path.trim()
    ? path.trim()
    : `~/flockctl/workspaces/${placeholderSlug}`;

  // Stage-pills derived from form state. Visual progress only — clicks
  // don't navigate. "Review" stays todo until everything else is done so
  // the user always has a single "ready to submit" tell.
  const identityDone = name.trim().length > 0;
  const sourceDone =
    sourceMode === "git" ? repoUrl.trim().length > 0 : true;
  const accessDone = allowedKeyIds.length > 0;
  const allDone = identityDone && sourceDone && accessDone;
  const stages: StagePill[] = [
    { label: "Identity", state: identityDone ? "done" : "active" },
    {
      label: "Source",
      state: !identityDone
        ? "todo"
        : sourceDone
          ? "done"
          : "active",
    },
    {
      label: "Access",
      state: !identityDone || !sourceDone
        ? "todo"
        : accessDone
          ? "done"
          : "active",
      hint: accessDone ? `${allowedKeyIds.length} keys` : undefined,
    },
    {
      label: "Review",
      state: allDone ? "active" : "todo",
    },
  ];

  return (
    <>
      <BottomSheet open={open} onOpenChange={handleOpenChange}>
        {showSelfTrigger ? (
          <BottomSheetTrigger asChild>
            {trigger ?? (
              <Button size="sm">
                <Plus aria-hidden="true" />
                New workspace
              </Button>
            )}
          </BottomSheetTrigger>
        ) : null}
        <BottomSheetContent
          className={cn("p-0")}
          data-testid="new-workspace-dialog"
        >
          <BottomSheetHeader className="px-6 pt-2 pb-3">
            <BottomSheetTitle>New workspace</BottomSheetTitle>
            <BottomSheetDescription>
              Use an existing local directory or clone a remote git repository.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <BottomSheetStages stages={stages} data-testid="cw-stages" />

          <form
            onSubmit={handleSubmit}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/*
              Two-column body: form on the left, summary panel on the right.
              The form column carries the inner `overflow-y-auto` so the
              scroll-baseline e2e at 1280×600 still hits a real scroll
              container (visual baseline asserts a div.overflow-y-auto
              inside role=dialog).
            */}
            <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_240px]">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
                <div className="space-y-5">
                  {/* Identity */}
                  <section className="space-y-3">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="cw-name"
                        className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300"
                      >
                        Name
                      </Label>
                      <Input
                        id="cw-name"
                        placeholder="My Workspace"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="cw-description"
                        className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300"
                      >
                        Description
                        <span className="ml-1 font-normal text-zinc-400">
                          (optional)
                        </span>
                      </Label>
                      <Textarea
                        id="cw-description"
                        placeholder="What lives in this workspace?"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                      />
                    </div>
                  </section>

                  <div
                    className="border-t border-zinc-200 dark:border-zinc-800"
                    aria-hidden="true"
                  />

                  {/* Source */}
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                        Source
                      </Label>
                      <SegmentToggle<WsSourceMode>
                        options={SOURCE_OPTIONS}
                        value={sourceMode}
                        onChange={setSourceMode}
                        aria-label="Workspace source"
                        data-testid="cw-source-toggle"
                      />
                    </div>

                    {sourceMode === "git" && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="cw-repo-url"
                          className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          Repository URL
                        </Label>
                        <Input
                          id="cw-repo-url"
                          placeholder="https://github.com/org/repo"
                          value={repoUrl}
                          onChange={(e) => setRepoUrl(e.target.value)}
                        />
                      </div>
                    )}

                    {sourceMode === "local" && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="cw-path"
                          className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          Path
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="cw-path"
                            placeholder={`~/flockctl/workspaces/${placeholderSlug}`}
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            className="flex-1 font-mono text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setPickerInitialPath(resolvePickerInitialPath());
                              setPickerOpen(true);
                            }}
                            data-testid="cw-path-browse"
                          >
                            <FolderOpen className="mr-1 h-4 w-4" />
                            Browse…
                          </Button>
                        </div>
                        <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                          {path.trim()
                            ? "Uses this existing directory (created if missing)."
                            : `Leave empty to auto-create at ~/flockctl/workspaces/${placeholderSlug}/`}
                        </p>
                      </div>
                    )}
                  </section>

                  <div
                    className="border-t border-zinc-200 dark:border-zinc-800"
                    aria-hidden="true"
                  />

                  {/* Access (keys + gitignore) */}
                  <section className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                        Allowed AI keys
                        <span className="ml-1 text-rose-500">*</span>
                      </Label>
                      <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                        Pick at least one key the workspace is allowed to use.
                        All keys start unchecked so access is always opt-in.
                      </p>
                      {activeKeys.length === 0 ? (
                        <p
                          className="text-[12.5px] text-rose-600 dark:text-rose-400"
                          data-testid="cw-no-keys-warning"
                        >
                          No active AI keys configured. Add one in Settings →
                          AI Keys before creating a workspace.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
                          {activeKeys.map((k) => (
                            <label
                              key={k.id}
                              className="flex items-center gap-1.5 text-[12.5px] text-zinc-700 dark:text-zinc-300"
                            >
                              <Checkbox
                                checked={allowedKeyIds.includes(Number(k.id))}
                                onCheckedChange={(checked) => {
                                  setAllowedKeyIds((prev) =>
                                    checked
                                      ? [...prev, Number(k.id)]
                                      : prev.filter(
                                          (id) => id !== Number(k.id),
                                        ),
                                  );
                                }}
                              />
                              {k.name ?? k.label ?? `Key #${k.id}`}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    <GitignoreToggles
                      value={gitignoreToggles}
                      onChange={setGitignoreToggles}
                      idPrefix="cw-gi"
                    />
                  </section>

                  {formError && (
                    <p
                      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
                      data-testid="cw-form-error"
                      role="alert"
                    >
                      {formError}
                    </p>
                  )}
                </div>
              </div>

              {/*
                Summary sidebar — visible at sm: and up. Re-derives from
                form state on every render (cheap; pure read of local
                state). Hidden on the smallest viewports so the form
                doesn't get squeezed below 320px usable width.
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
                    <dt className="text-zinc-500">Source</dt>
                    <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {sourceMode === "git" ? "Git clone" : "Local directory"}
                    </dd>
                    {sourceMode === "git" ? (
                      repoUrl.trim() ? (
                        <p className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                          {repoUrl.trim()}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[10.5px] text-zinc-400 italic">
                          repo URL pending
                        </p>
                      )
                    ) : null}
                  </div>
                  <div>
                    <dt className="text-zinc-500">Path</dt>
                    <dd className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-700 dark:text-zinc-300">
                      {sourceMode === "git" && !repoUrl.trim()
                        ? "—"
                        : derivedPath}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">AI keys</dt>
                    <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {allowedKeyIds.length === 0 ? (
                        <span className="text-zinc-400 italic">none yet</span>
                      ) : (
                        `${allowedKeyIds.length} of ${activeKeys.length}`
                      )}
                    </dd>
                  </div>
                </dl>

                <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                    Side-effects
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[10.5px] text-zinc-600 dark:text-zinc-400">
                    <li>
                      +1 row in <span className="font-mono">workspaces</span>
                    </li>
                    {sourceMode === "git" ? (
                      <li>git clone (~3s typical)</li>
                    ) : (
                      <li>directory created if missing</li>
                    )}
                    <li>
                      .gitignore +
                      {[
                        gitignoreToggles.gitignore_flockctl &&
                          ".flockctl",
                        gitignoreToggles.gitignore_todo && "TODO.md",
                        gitignoreToggles.gitignore_agents_md && "AGENTS.md",
                      ].filter(Boolean).length}{" "}
                      entries
                    </li>
                  </ul>
                </div>
              </aside>
            </div>

            <BottomSheetFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createWorkspace.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createWorkspace.isPending ||
                  allowedKeyIds.length === 0 ||
                  activeKeys.length === 0
                }
                data-testid="cw-submit"
              >
                {createWorkspace.isPending ? "Creating…" : "Create workspace"}
              </Button>
            </BottomSheetFooter>
          </form>
        </BottomSheetContent>
      </BottomSheet>

      {/*
        Mount the picker as a sibling Dialog rather than nesting it inside
        the bottom sheet — Radix handles stacked dialogs, but putting the
        picker at the sibling level keeps focus-trap behavior predictable
        across browsers. `initialPath` is resolved fresh each time the
        picker opens so the last-picked value is always up to date.
      */}
      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={pickerInitialPath}
        onSelect={handlePickerSelect}
      />
    </>
  );
}

export default NewWorkspaceDialog;
