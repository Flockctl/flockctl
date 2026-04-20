import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useWorkspaces,
  useCreateWorkspace,
  useDeleteWorkspace,
} from "@/lib/hooks";
import type { WorkspaceCreate } from "@/lib/types";
import { slugify } from "@/lib/utils";
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type WsSourceMode = "local" | "git";

function CreateWorkspaceDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceMode, setSourceMode] = useState<WsSourceMode>("local");
  const [repoUrl, setRepoUrl] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");

  const createWorkspace = useCreateWorkspace();

  function resetForm() {
    setName("");
    setSourceMode("local");
    setRepoUrl("");
    setDescription("");
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

    const data: WorkspaceCreate = { name: trimmedName };
    if (description.trim()) data.description = description.trim();

    if (sourceMode === "git") {
      const trimmedRepoUrl = repoUrl.trim();
      if (!trimmedRepoUrl) {
        setFormError("Repository URL is required.");
        return;
      }
      data.repoUrl = trimmedRepoUrl;
    }
    // path auto-derived by backend: ~/flockctl/workspaces/<name>

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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            Use an existing local directory or clone a remote git repository.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
          <p className="text-xs text-muted-foreground">
            Directory: ~/flockctl/workspaces/{name.trim() ? slugify(name) : "<name>"}/
          </p>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createWorkspace.isPending}>
              {createWorkspace.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const {
    data: workspaces,
    isLoading,
    error,
  } = useWorkspaces({ refetchInterval: 30_000 });
  const deleteWorkspace = useDeleteWorkspace();
  const deleteConfirm = useConfirmDialog();

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Workspaces</h1>
          <p className="mt-1 text-muted-foreground">
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
                <TableHead>Path</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((ws) => (
                <TableRow
                  key={ws.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/workspaces/${ws.id}`)}
                >
                  <TableCell className="font-medium">{ws.name}</TableCell>
                  <TableCell className="max-w-[300px] truncate font-mono text-xs">
                    {ws.path}
                  </TableCell>
                  <TableCell className="text-xs">
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
              ))}
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
