import { useEffect, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";

import { useCreateProject, useWorkspaces, useAIKeys } from "@/lib/hooks";
import { scanProjectPath } from "@/lib/api";
import type { ImportAction, ProjectCreate, ProjectScan } from "@/lib/types";
import { slugify } from "@/lib/utils";
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
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { Checkbox } from "@/components/ui/checkbox";
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
  type StagePill,
} from "@/components/design";

/**
 * NewProjectDialog — bottom-sheet refresh of the create-project flow.
 *
 * Behaviour is preserved verbatim from the prior shadcn-Dialog version:
 * same field set, same validation rules, same scan-debounce, same
 * `useCreateProject` mutation, same import-actions forwarded to the
 * backend, same `~/flockctl/projects/<slug>` placeholder.
 *
 * What changed (M27 refresh):
 *
 *   - Surface is now `BottomSheet` (slides up from the bottom edge of
 *     the viewport, centered horizontally, ~880px wide). Wider than the
 *     workspace sheet because the inner form keeps its 2-column
 *     `grid-cols-[160px_1fr]` label/control grid (the test asserts on
 *     this token literally — see
 *     `ui/src/__tests__/pages/projects-new-dialog.test.tsx`) which
 *     needs more horizontal headroom when sat next to the summary
 *     sidebar.
 *   - Stage-pills strip — Identity → Source → Access → Review — sits
 *     between header and body. Pills auto-color based on filled-ness;
 *     they're visual progress, not navigation.
 *   - Body is a 2-column layout: the legacy 160px-label grid on the
 *     left (preserves test selectors + visual fingerprint), a "Summary"
 *     sidebar on the right showing the live derived path, allowed-keys
 *     count, and import-action count.
 *
 * Test contract preserved:
 *
 *   - Dialog title text: `Create Project` (the unit test assert by
 *     `getByText` inside the dialog scope).
 *   - Test IDs: `new-project-trigger`, `new-project-dialog`,
 *     `new-project-form`, `new-project-grid` (with the literal classes
 *     `grid` + `grid-cols-[160px_1fr]`), `new-project-submit`,
 *     `new-project-error`, `cp-path-browse`.
 *   - Field IDs: `cp-name`, `cp-description`, `cp-path`, `cp-repo-url`,
 *     `cp-base-branch`, `cp-use-claude-skills`, `cp-gi-*`.
 *   - Trigger button text: "Create Project".
 *   - Submit button text: "Create" / "Creating…".
 *   - Inner scroll container retains `overflow-y-auto` (the same
 *     scroll-container assertion the workspace dialog test honours).
 */

// localStorage key that remembers the last directory the user picked via the
// DirectoryPicker, used as the next session's initialPath so re-opening the
// picker lands back where the user left off instead of $HOME.
const LAST_PICKED_PATH_KEY = "flockctl.lastPickedPath";

type SourceMode = "local" | "git";

function actionKey(a: ImportAction): string {
  return a.kind === "importClaudeSkill" ? `importClaudeSkill:${a.name}` : a.kind;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface ImportPreviewProps {
  scan: ProjectScan | null;
  scanning: boolean;
  error: string;
}

function ImportPreview({ scan, scanning, error }: ImportPreviewProps) {
  if (scanning && !scan) {
    return <p className="text-xs text-muted-foreground">Scanning directory…</p>;
  }
  if (error) {
    return <p className="text-xs text-destructive">Scan failed: {error}</p>;
  }
  if (!scan) return null;

  const items: Array<{ key: string; label: string; detail?: string; tone: "info" | "warn" }> = [];

  if (!scan.exists) {
    items.push({
      key: "not-exists",
      label: "Directory does not exist — will be created.",
      tone: "info",
    });
  } else {
    if (scan.alreadyManaged) {
      items.push({
        key: "already-managed",
        label: "This directory already has a .flockctl/ folder (previously imported).",
        tone: "info",
      });
    }
    if (scan.git.present) {
      items.push({
        key: "git",
        label: scan.git.originUrl
          ? `Git repo found — will adopt origin: ${scan.git.originUrl}`
          : "Git repo found (no origin remote).",
        tone: "info",
      });
    }
  }

  for (const action of scan.proposedActions) {
    switch (action.kind) {
      case "adoptAgentsMd":
        items.push({
          key: actionKey(action),
          label: `Move AGENTS.md → .flockctl/AGENTS.md`,
          detail: `${formatBytes(scan.conflicts.agentsMd.bytes)} — reconciler will regenerate the root file with our header.`,
          tone: "warn",
        });
        break;
      case "mergeClaudeMd":
        items.push({
          key: actionKey(action),
          label: `Merge CLAUDE.md into .flockctl/AGENTS.md`,
          detail: `${formatBytes(scan.conflicts.claudeMd.bytes)} — CLAUDE.md differs from AGENTS.md; both will be kept under BEGIN/END markers.`,
          tone: "warn",
        });
        break;
      case "importMcpJson":
        items.push({
          key: actionKey(action),
          label: `Import .mcp.json`,
          detail: `${scan.conflicts.mcpJson.servers.length} server(s): ${scan.conflicts.mcpJson.servers.join(", ")}.`,
          tone: "warn",
        });
        break;
      case "importClaudeSkill":
        items.push({
          key: actionKey(action),
          label: `Adopt skill: ${action.name}`,
          detail: `.claude/skills/${action.name}/ → .flockctl/skills/${action.name}/`,
          tone: "warn",
        });
        break;
    }
  }

  if (scan.conflicts.claudeMd.kind === "symlink-to-agents") {
    items.push({
      key: "claudemd-symlink-ok",
      label: "CLAUDE.md already points to AGENTS.md — nothing to do.",
      tone: "info",
    });
  }

  if (scan.conflicts.claudeAgents.length > 0) {
    items.push({
      key: "claude-agents",
      label: `.claude/agents/ has ${scan.conflicts.claudeAgents.length} file(s) — kept as-is.`,
      detail: scan.conflicts.claudeAgents.join(", "),
      tone: "info",
    });
  }
  if (scan.conflicts.claudeCommands.length > 0) {
    items.push({
      key: "claude-commands",
      label: `.claude/commands/ has ${scan.conflicts.claudeCommands.length} file(s) — kept as-is.`,
      detail: scan.conflicts.claudeCommands.join(", "),
      tone: "info",
    });
  }

  const hasWarn = items.some((i) => i.tone === "warn");
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3">
        <p className="text-xs text-muted-foreground">Empty directory — nothing to import.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Import preview</p>
        {hasWarn && (
          <p className="text-xs text-muted-foreground">
            Originals backed up to <code>.flockctl/import-backup/</code>.
          </p>
        )}
      </div>
      <ul className="space-y-1.5 max-h-60 overflow-y-auto">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-xs">
            <span
              className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full ${
                item.tone === "warn" ? "bg-yellow-400" : "bg-muted-foreground/30"
              }`}
            />
            <div className="flex-1">
              <p className={item.tone === "warn" ? "" : "text-muted-foreground"}>{item.label}</p>
              {item.detail && (
                <p className="text-muted-foreground font-mono text-[11px] mt-0.5">{item.detail}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Single labelled form row — the building block of the grid layout.
 *
 * `<Row label="Name" htmlFor="cp-name">…control…</Row>` renders as:
 *
 *   ┌──────────────┬──────────────────────────────┐
 *   │ Name         │ <Input id="cp-name" />        │
 *   └──────────────┴──────────────────────────────┘
 *
 * The label sits at the top of the row (`items-start` on the parent grid)
 * so multi-line controls (textarea, scan preview, allowed-keys grid)
 * visually anchor to the label rather than re-centering as they grow.
 *
 * `htmlFor` is optional — when omitted, the row renders a plain
 * non-interactive label (used for groups like the source segmented
 * control or the gitignore checkbox stack where there is no single
 * focusable target).
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

export interface NewProjectDialogProps {
  /** Optional render override for the trigger button. Defaults to "Create Project". */
  trigger?: React.ReactNode;
}

export function NewProjectDialog({ trigger }: NewProjectDialogProps = {}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("local");
  const [path, setPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [formError, setFormError] = useState("");

  const [scan, setScan] = useState<ProjectScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  // Directory picker is an augmentation of the path input, not a replacement:
  // the input still accepts paste / manual edits (the only option in remote
  // mode, where /fs/browse is loopback-gated). The picker just opens modally
  // and writes its result back into the same `path` state.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Snapshotted at picker-open time so that re-renders (e.g. user typing in
  // the Name field) don't re-seed the picker's internal state mid-session.
  const [pickerInitialPath, setPickerInitialPath] = useState<string | undefined>(undefined);
  // Allowed AI keys — required at create-time (see src/routes/_allowed-keys.ts).
  // Starts empty so the user must explicitly opt keys in: creating a project
  // that can talk to *every* key by default is how credentials leak into the
  // wrong project. Create is disabled until at least one is ticked.
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>([]);
  const [gitignoreToggles, setGitignoreToggles] = useState<GitignoreTogglesValue>(
    DEFAULT_GITIGNORE_TOGGLES,
  );
  // Per-project opt-in to honour `<project>/.claude/skills/` as a locked,
  // non-disableable skill source (DB-backed; migration 0045). Default off —
  // the user has to tick the matching checkbox in the dialog to opt in.
  const [useProjectClaudeSkills, setUseProjectClaudeSkills] = useState(false);
  const createProject = useCreateProject();
  const { data: workspacesList } = useWorkspaces({});
  const { data: aiKeys } = useAIKeys();
  const activeKeys = (aiKeys ?? []).filter((k) => k.is_active);

  function resetForm() {
    setName("");
    setDescription("");
    setSourceMode("local");
    setPath("");
    setRepoUrl("");
    setBaseBranch("main");
    setWorkspaceId("");
    setFormError("");
    setScan(null);
    setScanning(false);
    setScanError("");
    setPickerOpen(false);
    setAllowedKeyIds([]);
    setGitignoreToggles(DEFAULT_GITIGNORE_TOGGLES);
    setUseProjectClaudeSkills(false);
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

  // Debounced scan when user types a local path. Skip for git mode / empty path.
  useEffect(() => {
    if (sourceMode !== "local") {
      setScan(null);
      setScanError("");
      return;
    }
    const trimmed = path.trim();
    if (!trimmed) {
      setScan(null);
      setScanError("");
      return;
    }

    let cancelled = false;
    setScanning(true);
    const timer = setTimeout(async () => {
      try {
        const result = await scanProjectPath(trimmed);
        if (cancelled) return;
        setScan(result);
        setScanError("");
      } catch (err) {
        if (cancelled) return;
        setScan(null);
        setScanError(err instanceof Error ? err.message : "Scan failed");
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, sourceMode]);

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

    const data: ProjectCreate = {
      name: trimmedName,
      baseBranch: baseBranch.trim() || "main",
      allowed_key_ids: allowedKeyIds,
    };
    if (description.trim()) data.description = description.trim();
    if (workspaceId) data.workspace_id = Number(workspaceId);

    if (sourceMode === "git") {
      const trimmedRepoUrl = repoUrl.trim();
      if (!trimmedRepoUrl) {
        setFormError("Repository URL is required.");
        return;
      }
      data.repo_url = trimmedRepoUrl;
    } else {
      const trimmedPath = path.trim();
      if (trimmedPath) data.path = trimmedPath;
    }
    // If path is empty, backend auto-derives: ~/flockctl/projects/<name> or <workspace>/<name>

    if (sourceMode === "local" && scan?.proposedActions.length) {
      data.importActions = scan.proposedActions;
    }

    // Always forward the full toggle triplet. Now that the API defaults are
    // (true, true, false) — see `DEFAULT_GITIGNORE_TOGGLES` — sending only
    // the truthy fields would make "the user UNchecked the default" silently
    // collapse to "default" on the server. Always-send keeps the server's
    // row in lockstep with the form state regardless of the next default flip.
    data.gitignore_flockctl = gitignoreToggles.gitignore_flockctl;
    data.gitignore_todo = gitignoreToggles.gitignore_todo;
    data.gitignore_agents_md = gitignoreToggles.gitignore_agents_md;
    // Project `.claude/skills/` opt-in (locked, non-disableable). Always send
    // so unticking persists — server defaults to `false` only when omitted.
    data.use_project_claude_skills = useProjectClaudeSkills;

    try {
      await createProject.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create project");
    }
  }

  const placeholderSlug = name.trim() ? slugify(name) : "<name>";
  const derivedPath = path.trim()
    ? path.trim()
    : `~/flockctl/projects/${placeholderSlug}`;

  // Stage-pills derived from form state (visual progress only — not nav).
  const identityDone = name.trim().length > 0;
  const sourceDone = sourceMode === "git" ? repoUrl.trim().length > 0 : true;
  const accessDone = allowedKeyIds.length > 0;
  const allDone = identityDone && sourceDone && accessDone;
  const stages: StagePill[] = [
    { label: "Identity", state: identityDone ? "done" : "active" },
    {
      label: "Source",
      state: !identityDone ? "todo" : sourceDone ? "done" : "active",
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
    { label: "Review", state: allDone ? "active" : "todo" },
  ];

  const importActionCount = scan?.proposedActions.length ?? 0;

  return (
    <>
      <BottomSheet
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetForm();
        }}
      >
        <BottomSheetTrigger asChild>
          {trigger ?? (
            <Button size="sm" data-testid="new-project-trigger">
              <Plus aria-hidden="true" />
              New project
            </Button>
          )}
        </BottomSheetTrigger>
        <BottomSheetContent
          className="p-0 sm:max-w-[880px]"
          data-testid="new-project-dialog"
        >
          <BottomSheetHeader className="px-6 pt-2 pb-3">
            <BottomSheetTitle>Create Project</BottomSheetTitle>
            <BottomSheetDescription>
              Use an existing local directory or clone a remote git repository.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <BottomSheetStages stages={stages} data-testid="cp-stages" />

          <form
            onSubmit={handleSubmit}
            className="flex min-h-0 flex-1 flex-col"
            data-testid="new-project-form"
          >
            {/*
              Two-column body: form-grid on the left, summary on the right.
              The form column carries the inner `overflow-y-auto` so the
              scroll-baseline e2e at 1280×600 still hits a real scroll
              container inside `role=dialog`. The summary is hidden below
              `sm:` so the form keeps a usable width on narrow viewports.
            */}
            <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_240px]">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
                {/*
                  Inner 2-column label/control grid. The class token
                  `grid-cols-[160px_1fr]` is the visual fingerprint of the
                  M22+ refresh — `projects-new-dialog.test.tsx` asserts on
                  the literal class string, so a regression to a
                  `space-y-4` stack fails loudly here.
                */}
                <div
                  className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-3 items-start"
                  data-testid="new-project-grid"
                >
                  <Row label="Name" htmlFor="cp-name">
                    <Input
                      id="cp-name"
                      placeholder="My Project"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Row>

                  <Row label="Description" htmlFor="cp-description">
                    <Textarea
                      id="cp-description"
                      placeholder="Optional description..."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                    />
                  </Row>

                  <Row label="Source">
                    <div
                      className="flex gap-1 rounded-md border p-1"
                      role="tablist"
                      aria-label="Project source"
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant={sourceMode === "local" ? "default" : "ghost"}
                        className="flex-1"
                        onClick={() => setSourceMode("local")}
                        role="tab"
                        aria-selected={sourceMode === "local"}
                      >
                        Local Directory
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={sourceMode === "git" ? "default" : "ghost"}
                        className="flex-1"
                        onClick={() => setSourceMode("git")}
                        role="tab"
                        aria-selected={sourceMode === "git"}
                      >
                        Clone from Git
                      </Button>
                    </div>
                  </Row>

                  {sourceMode === "git" && (
                    <Row label="Repository URL" htmlFor="cp-repo-url">
                      <Input
                        id="cp-repo-url"
                        placeholder="https://github.com/org/repo"
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                      />
                    </Row>
                  )}

                  {sourceMode === "local" && (
                    <Row
                      label="Path"
                      htmlFor="cp-path"
                      hint={
                        path.trim()
                          ? "Uses this existing directory (created if missing)."
                          : `Leave empty to auto-create at ~/flockctl/projects/${name.trim() ? slugify(name) : "<name>"}/`
                      }
                    >
                      {/*
                        Input + Browse button live on the same row. The input
                        keeps accepting paste / manual edits — remote-mode users
                        can't use the picker (it's loopback-only on the server)
                        and some local users prefer to paste. Browse is purely
                        additive.
                      */}
                      <div className="flex gap-2">
                        <Input
                          id="cp-path"
                          placeholder={`~/flockctl/projects/${name.trim() ? slugify(name) : "<name>"}`}
                          value={path}
                          onChange={(e) => setPath(e.target.value)}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setPickerInitialPath(resolvePickerInitialPath());
                            setPickerOpen(true);
                          }}
                          data-testid="cp-path-browse"
                        >
                          <FolderOpen className="mr-1 h-4 w-4" />
                          Browse…
                        </Button>
                      </div>
                    </Row>
                  )}

                  {sourceMode === "local" && path.trim() !== "" && (
                    <Row label="Import preview">
                      <ImportPreview scan={scan} scanning={scanning} error={scanError} />
                    </Row>
                  )}

                  <Row label="Base Branch" htmlFor="cp-base-branch">
                    <Input
                      id="cp-base-branch"
                      placeholder="main"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                    />
                  </Row>

                  {workspacesList && workspacesList.length > 0 && (
                    <Row
                      label="Workspace"
                      hint="Optional. Assign this project to a workspace."
                    >
                      <Select
                        value={workspaceId || "__none__"}
                        onValueChange={(v) => setWorkspaceId(v === "__none__" ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="None (standalone project)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None (standalone project)</SelectItem>
                          {workspacesList.map((ws) => (
                            <SelectItem key={ws.id} value={String(ws.id)}>
                              {ws.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                  )}

                  <Row
                    label="Allowed AI Keys *"
                    hint="Pick at least one key the project is allowed to use. All keys start unchecked so access is always opt-in."
                  >
                    {activeKeys.length === 0 ? (
                      <p className="text-sm text-destructive">
                        No active AI keys configured. Add one in Settings → AI Keys before
                        creating a project.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {activeKeys.map((k) => (
                          <label
                            key={k.id}
                            className="flex items-center gap-1.5 text-sm"
                          >
                            <Checkbox
                              checked={allowedKeyIds.includes(Number(k.id))}
                              onCheckedChange={(checked) => {
                                setAllowedKeyIds((prev) =>
                                  checked
                                    ? [...prev, Number(k.id)]
                                    : prev.filter((id) => id !== Number(k.id)),
                                );
                              }}
                            />
                            {k.name ?? k.label ?? `Key #${k.id}`}
                          </label>
                        ))}
                      </div>
                    )}
                  </Row>

                  <Row label="Gitignore">
                    {/*
                      GitignoreToggles renders its own internal heading +
                      description by default; suppressing the title here
                      avoids a duplicate label, since the grid's left
                      column already says "Gitignore".
                    */}
                    <GitignoreToggles
                      value={gitignoreToggles}
                      onChange={setGitignoreToggles}
                      idPrefix="cp-gi"
                      title=""
                    />
                  </Row>

                  {/*
                    Project-owned skills opt-in. Lives directly under the
                    gitignore row because both are DB-backed flags reconciled
                    into the project tree on save. Unticked by default — the
                    operator has to explicitly opt in for
                    `<project>/.claude/skills/` to count as a skill source.
                  */}
                  <Row label="Project skills">
                    <label
                      htmlFor="cp-use-claude-skills"
                      className="flex items-start gap-2 rounded-md border p-3 text-sm"
                    >
                      <Checkbox
                        id="cp-use-claude-skills"
                        checked={useProjectClaudeSkills}
                        onCheckedChange={(next) => setUseProjectClaudeSkills(next === true)}
                      />
                      <span className="flex-1">
                        <span className="block leading-tight">
                          Use skills from this project's <code>.claude/skills/</code>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Every <code>SKILL.md</code> under the project's{" "}
                          <code>.claude/skills/</code> directory becomes a locked,
                          always-on skill that overrides any same-name skill from
                          global / workspace / <code>.flockctl/skills/</code>.
                          Locked skills bypass the per-skill disable list — they
                          cannot be turned off through the skills toggles.
                        </span>
                      </span>
                    </label>
                  </Row>

                  {formError && (
                    <Row label="">
                      <p className="text-sm text-destructive" data-testid="new-project-error">
                        {formError}
                      </p>
                    </Row>
                  )}
                </div>
              </div>

              {/*
                Summary sidebar — derives from form state on every render
                (cheap; pure read of local state). Hidden below `sm:` so
                narrow viewports keep a usable single-column form.
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
                    <dt className="text-zinc-500">Base branch</dt>
                    <dd className="mt-0.5 font-mono text-[10.5px] text-zinc-700 dark:text-zinc-300">
                      {baseBranch.trim() || "main"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Workspace</dt>
                    <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {workspaceId
                        ? workspacesList?.find(
                            (w) => String(w.id) === workspaceId,
                          )?.name ?? "—"
                        : "Standalone"}
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
                      +1 row in <span className="font-mono">projects</span>
                    </li>
                    {sourceMode === "git" ? (
                      <li>git clone (~3s typical)</li>
                    ) : (
                      <li>directory created if missing</li>
                    )}
                    {importActionCount > 0 && (
                      <li>
                        {importActionCount} import action
                        {importActionCount === 1 ? "" : "s"}
                      </li>
                    )}
                  </ul>
                </div>
              </aside>
            </div>

            <BottomSheetFooter>
              <Button
                type="submit"
                data-testid="new-project-submit"
                disabled={
                  createProject.isPending ||
                  allowedKeyIds.length === 0 ||
                  activeKeys.length === 0
                }
              >
                {createProject.isPending ? "Creating…" : "Create"}
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

export default NewProjectDialog;
