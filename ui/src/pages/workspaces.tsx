import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useWorkspaces,
  useCreateWorkspace,
  useDeleteWorkspace,
  useAIKeys,
  useProjects,
  useAttention,
} from "@/lib/hooks";
import type { WorkspaceCreate } from "@/lib/types";
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

// Shared with the project-create form (ui/src/pages/projects.tsx). Using the
// same localStorage key means the picker's "last picked directory" memory is
// reused across both flows — pick a folder when creating a project, then the
// next workspace create lands in the same neighbourhood (and vice versa).
const LAST_PICKED_PATH_KEY = "flockctl.lastPickedPath";

type WsSourceMode = "local" | "git";

function CreateWorkspaceDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceMode, setSourceMode] = useState<WsSourceMode>("local");
  const [path, setPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  // Directory picker is an augmentation of the path input, not a replacement:
  // the input still accepts paste / manual edits (the only option in remote
  // mode, where /fs/browse is loopback-gated). The picker just opens modally
  // and writes its result back into the same `path` state. Mirrors the
  // project-create form verbatim.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Snapshotted at picker-open time so that re-renders (e.g. user typing in
  // the Name field) don't re-seed the picker's internal state mid-session.
  const [pickerInitialPath, setPickerInitialPath] = useState<string | undefined>(undefined);
  // Allowed AI keys — required at create-time (see src/routes/_allowed-keys.ts).
  // Starts empty so the user must explicitly opt keys in: creating a workspace
  // that can talk to *every* key by default is how credentials leak into the
  // wrong project. Create is disabled until at least one is ticked.
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>([]);
  const [gitignoreToggles, setGitignoreToggles] = useState<GitignoreTogglesValue>(
    DEFAULT_GITIGNORE_TOGGLES,
  );

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

    // Only send toggles that the user actually enabled. Omitted fields
    // default to `false` server-side (current behaviour).
    if (gitignoreToggles.gitignore_flockctl) data.gitignore_flockctl = true;
    if (gitignoreToggles.gitignore_todo) data.gitignore_todo = true;
    if (gitignoreToggles.gitignore_agents_md) data.gitignore_agents_md = true;

    try {
      await createWorkspace.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create workspace",
      );
    }
  }

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button>Create Workspace</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            Use an existing local directory or clone a remote git repository.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 min-h-0 flex-1">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1 -mr-1">
          <div className="space-y-2">
            <Label htmlFor="cw-name">Name</Label>
            <Input
              id="cw-name"
              placeholder="My Workspace"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cw-description">Description</Label>
            <Textarea
              id="cw-description"
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
              <Label htmlFor="cw-repo-url">Repository URL</Label>
              <Input
                id="cw-repo-url"
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
            </div>
          )}
          {sourceMode === "local" && (
            <div className="space-y-2">
              <Label htmlFor="cw-path">Path</Label>
              {/* Input + Browse button live on the same row. The input keeps
                  accepting paste / manual edits — remote-mode users can't use
                  the picker (it's loopback-only on the server) and some local
                  users prefer to paste. Browse is purely additive. */}
              <div className="flex gap-2">
                <Input
                  id="cw-path"
                  placeholder={`~/flockctl/workspaces/${name.trim() ? slugify(name) : "<name>"}`}
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
                  data-testid="cw-path-browse"
                >
                  <FolderOpen className="mr-1 h-4 w-4" />
                  Browse…
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {path.trim()
                  ? "Uses this existing directory (created if missing)."
                  : `Leave empty to auto-create at ~/flockctl/workspaces/${name.trim() ? slugify(name) : "<name>"}/`}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Allowed AI Keys *</Label>
            <p className="text-xs text-muted-foreground">
              Pick at least one key the workspace is allowed to use. All keys
              start unchecked so access is always opt-in.
            </p>
            {activeKeys.length === 0 ? (
              <p className="text-sm text-destructive">
                No active AI keys configured. Add one in Settings → AI Keys
                before creating a workspace.
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
            idPrefix="cw-gi"
          />
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                createWorkspace.isPending ||
                allowedKeyIds.length === 0 ||
                activeKeys.length === 0
              }
            >
              {createWorkspace.isPending ? "Creating…" : "Create"}
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

// ─── Attention-count data flow (audit 2026-04-23) ──────────────────────────
// The "N waiting" badge per workspace row is NOT available as a field on any
// existing endpoint. Audited options (cheapest → most expensive):
//
//   (a) Field on GET /workspaces ............... ✗ not present. Response carries
//       only {id,name,description,path,repoUrl,allowedKeyIds,gitignore*,
//       createdAt,updatedAt} — no pending_attention_count.
//   (b) Sum over workspace.projects[] .......... ✗ not applicable. /workspaces
//       does NOT embed a projects[] array; workspaces and projects are two
//       flat endpoints joined only by project.workspaceId.
//   (c) useAttention({ workspaceId }) per row .. ✗ N+1 and not supported.
//       useAttention() takes no arguments; it is a single global inbox fetch
//       (ui/src/lib/hooks/attention.ts:36), WS-invalidated on attention_changed.
//
// Chosen approach — mirror ui/src/pages/projects.tsx:614-625:
//   1. Call useAttention() ONCE at page level → flat AttentionItem[] carrying
//      project_id (not workspace_id — see ui/src/lib/api/attention.ts:16-51).
//   2. Call useProjects() ONCE to build a project_id → workspaceId map.
//   3. In each row, compute count = Σ items where map.get(item.project_id)
//      === ws.id. Two total HTTP calls regardless of row count; no N+1.
// ────────────────────────────────────────────────────────────────────────────
export default function WorkspacesPage() {
  const navigate = useNavigate();
  const {
    data: workspaces,
    isLoading,
    error,
  } = useWorkspaces({ refetchInterval: 30_000 });
  const deleteWorkspace = useDeleteWorkspace();
  const deleteConfirm = useConfirmDialog();
  const { data: projects } = useProjects();
  const { items: attentionItems } = useAttention();

  // See the "Attention-count data flow" note above: two flat fetches
  // (useProjects + useAttention) compose into a workspace_id → count map
  // without N+1 calls. We route each attention item through its project
  // to find the owning workspace.
  const attentionByWorkspace = useMemo(() => {
    const projectToWorkspace = new Map<string, string>();
    for (const p of projects ?? []) {
      if (p.workspace_id == null) continue;
      projectToWorkspace.set(p.id, String(p.workspace_id));
    }
    const counts = new Map<string, number>();
    for (const item of attentionItems) {
      if (!item.project_id) continue;
      const wsId = projectToWorkspace.get(item.project_id);
      if (!wsId) continue;
      counts.set(wsId, (counts.get(wsId) ?? 0) + 1);
    }
    return counts;
  }, [projects, attentionItems]);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold sm:text-2xl">Workspaces</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Organize projects into workspaces.
          </p>
        </div>
        <CreateWorkspaceDialog />
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
            Failed to load workspaces: {error.message}
          </p>
        )}
        {workspaces && workspaces.length === 0 && (
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        )}
        {workspaces && workspaces.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Path</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((ws) => {
                const attentionCount = attentionByWorkspace.get(ws.id) ?? 0;
                return (
                <TableRow
                  key={ws.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/workspaces/${ws.id}`)}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span>{ws.name}</span>
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
                    {ws.path}
                  </TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">
                    {timeAgo(ws.created_at)}
                  </TableCell>
                  <TableCell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={deleteWorkspace.isPending}
                        onClick={() => deleteConfirm.requestConfirm(ws.id)}
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
        title="Delete Workspace"
        description="This will permanently delete the workspace and remove all project associations. This action cannot be undone."
        isPending={deleteWorkspace.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteWorkspace.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
