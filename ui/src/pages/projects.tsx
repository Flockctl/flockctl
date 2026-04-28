import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useCreateProject, useDeleteProject, useWorkspaces, useAttention, useAIKeys } from "@/lib/hooks";
import { scanProjectPath } from "@/lib/api";
import type { ImportAction, ProjectCreate, ProjectScan } from "@/lib/types";
import { slugify, timeAgo } from "@/lib/utils";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { Checkbox } from "@/components/ui/checkbox";
import {
  GitignoreToggles,
  DEFAULT_GITIGNORE_TOGGLES,
  type GitignoreTogglesValue,
} from "@/components/gitignore-toggles";
import { FolderOpen } from "lucide-react";

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

function CreateProjectDialog() {
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

    // Only forward toggles the user actually enabled — omitting preserves the
    // server-side default of `false` and keeps the wire payload minimal.
    if (gitignoreToggles.gitignore_flockctl) data.gitignore_flockctl = true;
    if (gitignoreToggles.gitignore_todo) data.gitignore_todo = true;
    if (gitignoreToggles.gitignore_agents_md) data.gitignore_agents_md = true;

    try {
      await createProject.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create project");
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        <Button>Create Project</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Use an existing local directory or clone a remote git repository.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 min-h-0 flex-1">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1 -mr-1">
          <div className="space-y-2">
            <Label htmlFor="cp-name">Name</Label>
            <Input
              id="cp-name"
              placeholder="My Project"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-description">Description</Label>
            <Textarea
              id="cp-description"
              placeholder="Optional description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label>Source</Label>
            <div className="flex gap-1 rounded-md border p-1">
              <Button
                type="button"
                size="sm"
                variant={sourceMode === "local" ? "default" : "ghost"}
                className="flex-1"
                onClick={() => setSourceMode("local")}
              >
                Local Directory
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sourceMode === "git" ? "default" : "ghost"}
                className="flex-1"
                onClick={() => setSourceMode("git")}
              >
                Clone from Git
              </Button>
            </div>
          </div>
          {sourceMode === "git" && (
            <div className="space-y-2">
              <Label htmlFor="cp-repo-url">Repository URL</Label>
              <Input
                id="cp-repo-url"
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
            </div>
          )}
          {sourceMode === "local" && (
            <div className="space-y-2">
              <Label htmlFor="cp-path">Path</Label>
              {/* Input + Browse button live on the same row. The input keeps
                  accepting paste / manual edits — remote-mode users can't use
                  the picker (it's loopback-only on the server) and some local
                  users prefer to paste. Browse is purely additive. */}
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
              <p className="text-xs text-muted-foreground">
                {path.trim()
                  ? "Uses this existing directory (created if missing)."
                  : `Leave empty to auto-create at ~/flockctl/projects/${name.trim() ? slugify(name) : "<name>"}/`}
              </p>
            </div>
          )}
          {sourceMode === "local" && path.trim() !== "" && (
            <ImportPreview
              scan={scan}
              scanning={scanning}
              error={scanError}
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="cp-base-branch">Base Branch</Label>
            <Input
              id="cp-base-branch"
              placeholder="main"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
          </div>
          {workspacesList && workspacesList.length > 0 && (
            <div className="space-y-2">
              <Label>Workspace</Label>
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
              <p className="text-xs text-muted-foreground">
                Optional. Assign this project to a workspace.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Allowed AI Keys *</Label>
            <p className="text-xs text-muted-foreground">
              Pick at least one key the project is allowed to use. All keys
              start unchecked so access is always opt-in.
            </p>
            {activeKeys.length === 0 ? (
              <p className="text-sm text-destructive">
                No active AI keys configured. Add one in Settings → AI Keys
                before creating a project.
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
          </div>
          <GitignoreToggles
            value={gitignoreToggles}
            onChange={setGitignoreToggles}
            idPrefix="cp-gi"
          />
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                createProject.isPending ||
                allowedKeyIds.length === 0 ||
                activeKeys.length === 0
              }
            >
              {createProject.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {/* Mount the picker as a sibling Dialog rather than nesting it inside
        the Create dialog — Radix handles stacked dialogs, but putting the
        picker at the sibling level keeps focus-trap behavior predictable
        across browsers. `initialPath` is resolved fresh each time the
        picker opens so the last-picked value is always up to date. */}
    <DirectoryPicker
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      initialPath={pickerInitialPath}
      onSelect={handlePickerSelect}
    />
    </>
  );
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects({
    refetchInterval: 30_000,
  });
  const deleteProject = useDeleteProject();
  const deleteConfirm = useConfirmDialog();
  const { items: attentionItems } = useAttention();

  // Count attention items grouped by project so each row can surface its
  // own "N waiting" badge without introducing a new column.
  const attentionByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of attentionItems) {
      if (!item.project_id) continue;
      map.set(item.project_id, (map.get(item.project_id) ?? 0) + 1);
    }
    return map;
  }, [attentionItems]);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold sm:text-2xl">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Manage your projects and planning hierarchy.
          </p>
        </div>
        <CreateProjectDialog />
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
            Failed to load projects: {error.message}
          </p>
        )}
        {projects && projects.length === 0 && (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        )}
        {projects && projects.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Location</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const attentionCount = attentionByProject.get(project.id) ?? 0;
                return (
                <TableRow
                  key={project.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/projects/${project.id}`)}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span>{project.name}</span>
                      {attentionCount > 0 && (
                        <Badge
                          variant="destructive"
                          className="cursor-pointer"
                          aria-label={`${attentionCount} item${attentionCount === 1 ? "" : "s"} waiting on you`}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("/attention");
                          }}
                        >
                          {attentionCount} waiting
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-[300px] truncate font-mono text-xs md:table-cell">
                    {project.repo_url || project.path || "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">
                    {timeAgo(project.created_at)}
                  </TableCell>
                  <TableCell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={deleteProject.isPending}
                        onClick={() => deleteConfirm.requestConfirm(project.id)}
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
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Project"
        description="This will permanently delete the project and all its milestones, slices, and tasks. This action cannot be undone."
        isPending={deleteProject.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteProject.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
