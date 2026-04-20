import { useState } from "react";
import { Plus, Trash2, PencilLine, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useServerContext } from "@/contexts/server-context";
import { apiFetch } from "@/lib/api";
import type { ServerConnection } from "@/lib/types";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

async function probeServer(url: string, token?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ServerFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: ServerConnection | null;
  onSaved: () => Promise<void> | void;
}) {
  const editing = !!initial && !initial.is_local;
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState("");
  const [changeToken, setChangeToken] = useState(!editing);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setName(initial?.name ?? "");
    setUrl(initial?.url ?? "");
    setToken("");
    setChangeToken(!editing);
    setError(null);
    setSaving(false);
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    setError(null);
    if (!name.trim() || !url.trim()) {
      setError("Name and URL are required");
      return;
    }
    setSaving(true);
    try {
      const trimmedUrl = url.trim().replace(/\/$/, "");
      const effectiveToken = changeToken ? token.trim() : undefined;
      // Probe first — fail fast before persisting.
      const ok = await probeServer(trimmedUrl, effectiveToken || undefined);
      if (!ok) {
        setError(
          "Could not reach the server at /health. Check the URL, token, and that Flockctl is running there.",
        );
        setSaving(false);
        return;
      }

      if (editing && initial) {
        const payload: Record<string, unknown> = { name: name.trim(), url: trimmedUrl };
        if (changeToken) payload.token = effectiveToken ?? null;
        await apiFetch(`/meta/remote-servers/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch(`/meta/remote-servers`, {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            url: trimmedUrl,
            token: effectiveToken || undefined,
          }),
        });
      }
      await onSaved();
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Server" : "Add Server"}</DialogTitle>
          <DialogDescription>
            Connect to a remote Flockctl instance. Tokens live in the backend's{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>{" "}
            (chmod 600) — they never touch browser storage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="server-name">Name</Label>
            <Input
              id="server-name"
              placeholder="Production"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="server-url">URL</Label>
            <Input
              id="server-url"
              placeholder="https://flockctl.example.com:52077"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="server-token">Access token</Label>
              {editing && !changeToken && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setChangeToken(true)}
                >
                  Change token
                </button>
              )}
            </div>
            {changeToken ? (
              <Input
                id="server-token"
                type="password"
                placeholder={
                  editing ? "Enter new token, or leave empty to clear" : "Bearer token (optional)"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="font-mono text-sm"
              />
            ) : (
              <Input
                disabled
                value="••••••••••••"
                className="font-mono text-sm"
              />
            )}
            <p className="text-xs text-muted-foreground">
              Generate on the remote host with{" "}
              <code className="rounded bg-muted px-1 py-0.5">flockctl token</code>.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ServerConnectionsList() {
  const { servers, refreshServers, testConnection, activeServer } = useServerContext();
  const [editing, setEditing] = useState<ServerConnection | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const deleteConfirm = useConfirmDialog();

  async function handleDelete(id: string) {
    await apiFetch(`/meta/remote-servers/${id}`, { method: "DELETE" });
    await refreshServers();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Remote connections</h3>
          <p className="text-xs text-muted-foreground">
            The Local entry is always present and points at this machine.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add server
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>Token</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[160px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {servers.map((server) => {
            const isActive = server.id === activeServer.id;
            return (
              <TableRow key={server.id}>
                <TableCell className="font-medium">{server.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {server.is_local ? "(current origin)" : server.url}
                </TableCell>
                <TableCell>
                  {server.is_local ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : server.has_token ? (
                    <Badge variant="outline">configured</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      none
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {isActive ? (
                    <Badge className="bg-green-600 text-white dark:bg-green-700">Active</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">idle</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {isActive && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void testConnection()}
                        title="Test connection"
                      >
                        <RotateCw className="h-3 w-3" />
                      </Button>
                    )}
                    {!server.is_local && (
                      <>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setEditing(server)}
                          title="Edit"
                        >
                          <PencilLine className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-destructive hover:text-destructive"
                          onClick={() => deleteConfirm.requestConfirm(server.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ServerFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={refreshServers}
      />

      <ServerFormDialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        initial={editing}
        onSaved={refreshServers}
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete server connection"
        description="This removes the saved URL and token from ~/.flockctlrc. This cannot be undone."
        onConfirm={() => {
          const id = deleteConfirm.targetId;
          if (!id) return;
          void handleDelete(id).finally(() => deleteConfirm.reset());
        }}
      />
    </div>
  );
}
