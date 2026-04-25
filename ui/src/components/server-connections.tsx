import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, PencilLine, RotateCw, MoreVertical } from "lucide-react";
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
import { errorCodeMessage } from "@/lib/types/common";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Add Server form — SSH-only
// ---------------------------------------------------------------------------
//
// Keeps 1:1 parity with the server-side zod schema in
// `src/routes/meta.ts` (sshConfigCreateSchema). The regex here MUST match
// `SSH_HOST_REGEX` in that file. Validating client-side gives users a crisp
// inline hint instead of a 400 from the daemon.

/** Mirrors the backend `SSH_HOST_REGEX` in `src/routes/meta.ts`. */
export const SSH_HOST_REGEX = /^[A-Za-z0-9_.\-@:]+$/;

export interface AddServerFormPayload {
  name: string;
  ssh: {
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    remotePort?: number;
  };
}

export interface AddServerFormProps {
  onSubmit: (payload: AddServerFormPayload) => void | Promise<void>;
  onCancel?: () => void;
  submitting?: boolean;
  error?: string | null;
  /** Submit button label — overridable so the dialog can say "Add server". */
  submitLabel?: string;
}

/** Parse a port-ish string input. Returns undefined when blank/invalid. */
function parsePort(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Add-Server form body — SSH-only fields in a fixed order.
 *
 * Field order is deliberate (muscle memory + a11y):
 *   1. Name
 *   2. Host
 *   3. User
 *   4. Port
 *   5. Identity file
 *   6. Remote port  ← hidden behind an "Advanced" <details> disclosure
 *
 * The submit handler builds `{ name, ssh: { host, user?, port?, identityFile?,
 * remotePort? } }` and OMITS any optional key whose input is blank — so the
 * request stays minimal and matches the backend's .strict() zod shape.
 */
export function AddServerForm({
  onSubmit,
  onCancel,
  submitting = false,
  error,
  submitLabel = "Add server",
}: AddServerFormProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const trimmedHost = host.trim();
  const nameValid = name.trim().length > 0;
  const hostValid = trimmedHost.length > 0 && SSH_HOST_REGEX.test(trimmedHost);
  const hostFormatError =
    trimmedHost.length > 0 && !SSH_HOST_REGEX.test(trimmedHost)
      ? "Host contains invalid characters"
      : null;

  const canSubmit = nameValid && hostValid && !submitting;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;

    const ssh: AddServerFormPayload["ssh"] = { host: trimmedHost };
    const trimmedUser = user.trim();
    if (trimmedUser) ssh.user = trimmedUser;
    const parsedPort = parsePort(port);
    if (parsedPort !== undefined) ssh.port = parsedPort;
    const trimmedIdentity = identityFile.trim();
    if (trimmedIdentity) ssh.identityFile = trimmedIdentity;
    const parsedRemote = parsePort(remotePort);
    if (parsedRemote !== undefined) ssh.remotePort = parsedRemote;

    await onSubmit({ name: name.trim(), ssh });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 1. Name */}
      <div className="space-y-2">
        <Label htmlFor="server-name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="server-name"
          placeholder="Production"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
      </div>

      {/* 2. Host */}
      <div className="space-y-2">
        <Label htmlFor="server-host">
          Host <span className="text-destructive">*</span>
        </Label>
        <Input
          id="server-host"
          placeholder="user@host.example.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="font-mono text-sm"
          aria-invalid={hostFormatError ? true : undefined}
          aria-describedby={hostFormatError ? "server-host-error" : "server-host-help"}
          required
        />
        {hostFormatError ? (
          <p id="server-host-error" className="text-xs text-destructive">
            {hostFormatError}
          </p>
        ) : (
          <p id="server-host-help" className="text-xs text-muted-foreground">
            Hostname, IP, or <code className="rounded bg-muted px-1">~/.ssh/config</code> alias.
          </p>
        )}
      </div>

      {/* 3. User */}
      <div className="space-y-2">
        <Label htmlFor="server-user">User</Label>
        <Input
          id="server-user"
          placeholder="Optional — omit if embedded in Host"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          className="font-mono text-sm"
        />
      </div>

      {/* 4. Port */}
      <div className="space-y-2">
        <Label htmlFor="server-port">Port</Label>
        <Input
          id="server-port"
          type="number"
          inputMode="numeric"
          min={1}
          max={65535}
          placeholder="22"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="font-mono text-sm"
        />
      </div>

      {/* 5. Identity file */}
      <div className="space-y-2">
        <Label htmlFor="server-identity">Identity file</Label>
        <Input
          id="server-identity"
          placeholder="Optional — e.g. ~/.ssh/id_ed25519"
          value={identityFile}
          onChange={(e) => setIdentityFile(e.target.value)}
          className="font-mono text-sm"
        />
      </div>

      {/* 6. Remote port — advanced / disclosure */}
      <details
        className="rounded-md border border-border/60 bg-muted/20 px-3 py-2"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
          Advanced
        </summary>
        <div className="mt-3 space-y-2">
          <Label htmlFor="server-remote-port">Remote port</Label>
          <Input
            id="server-remote-port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            placeholder="52077"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Port the Flockctl daemon listens on (remote side of the SSH tunnel).
          </p>
        </div>
      </details>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add Server dialog — thin wrapper that POSTs the form payload to the daemon
// ---------------------------------------------------------------------------

function AddServerDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(payload: AddServerFormPayload) {
    setError(null);
    setSubmitting(true);
    try {
      // rawKeys:true preserves camelCase keys (identityFile, remotePort) —
      // apiFetch's default would snake-case them and the server's
      // .strict() schema rejects unknown keys.
      await apiFetch(`/meta/remote-servers`, {
        method: "POST",
        body: JSON.stringify(payload),
        rawKeys: true,
      });
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose(v: boolean) {
    if (!v) {
      setError(null);
      setSubmitting(false);
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
          <DialogDescription>
            Connect to a remote Flockctl daemon over SSH. Flockctl runs{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">flockctl remote-bootstrap</code>{" "}
            on the host to mint a bearer token, which is stored in your local{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>{" "}
            (chmod 600) — never in browser storage.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on `open` so re-opening the dialog gives a blank form. */}
        <AddServerForm
          key={open ? "open" : "closed"}
          onSubmit={handleSubmit}
          onCancel={() => handleClose(false)}
          submitting={submitting}
          error={error}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rename dialog — the only mutation the UI supports on an existing row.
// SSH target changes mean delete + re-add (the bootstrap flow has to run
// again anyway to mint a new token against the new host).
// ---------------------------------------------------------------------------

function RenameServerDialog({
  server,
  onOpenChange,
  onSaved,
}: {
  server: ServerConnection;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(server.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/meta/remote-servers/${server.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
        rawKeys: true,
      });
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename server</DialogTitle>
          <DialogDescription>
            Rename the local label for this connection. To change the SSH target,
            delete and re-add the server.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="server-rename">Name</Label>
          <Input
            id="server-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={submitting || !name.trim()}>
            {submitting ? "Saving…" : "Save changes"}
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
            <TableHead>Host</TableHead>
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
                  {server.is_local ? "(this machine)" : sshHostSummary(server)}
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
                          title="Rename"
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

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={refreshServers}
      />

      {editing && (
        <RenameServerDialog
          server={editing}
          onOpenChange={(v) => !v && setEditing(null)}
          onSaved={refreshServers}
        />
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete server connection"
        description="This stops the SSH tunnel and removes the saved server entry from ~/.flockctlrc. This cannot be undone."
        onConfirm={() => {
          const id = deleteConfirm.targetId;
          if (!id) return;
          void handleDelete(id).finally(() => deleteConfirm.reset());
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServerRow
//
// One row of the remote-servers list on the dashboard. Renders a status dot,
// the server name, the SSH host summary, and a kebab menu with per-status
// actions. Owns optimistic local state for the two mutations that move fast
// enough to need it:
//   • Reconnect: flips the displayed status to "starting" immediately so the
//     dot goes amber without waiting for the next poll.
//   • Remove: hides the row immediately and rolls back (re-renders) if the
//     DELETE rejects. On success the parent's refetch (triggered by
//     onChanged) is what formally drops the row from the list.
//
// The tooltip on the status dot only carries a message when status === "error"
// — for the other three states there's nothing useful to say.
// ---------------------------------------------------------------------------

export type ServerRowStatus = NonNullable<ServerConnection["tunnelStatus"]>;

export interface ServerRowProps {
  server: ServerConnection;
  /** Fired after any successful action so the list can refetch. */
  onChanged?: () => void;
}

const STATUS_DOT_CLASS: Record<ServerRowStatus, string> = {
  ready: "bg-green-500",
  starting: "bg-amber-500 animate-pulse",
  error: "bg-red-500",
  stopped: "bg-muted-foreground/40",
};

function sshHostSummary(server: ServerConnection): string {
  const ssh = server.ssh;
  if (!ssh) return "—";
  const base = ssh.host;
  // If the host already embeds a user (user@host) leave it alone; otherwise
  // prepend ssh.user when we have one so the row reflects the SSH identity
  // the tunnel will actually use.
  const hasEmbeddedUser = base.includes("@");
  const withUser = !hasEmbeddedUser && ssh.user ? `${ssh.user}@${base}` : base;
  return ssh.port && ssh.port !== 22 ? `${withUser}:${ssh.port}` : withUser;
}

export function ServerRow({ server, onChanged }: ServerRowProps) {
  // Optimistic overrides layered on top of the server prop. Cleared whenever
  // the parent hands us a new server object (the refetch landed) or whenever
  // an in-flight mutation rejects.
  const [statusOverride, setStatusOverride] = useState<ServerRowStatus | null>(null);
  const [removed, setRemoved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Drop overrides when the authoritative prop changes — prevents stale
  // "starting" from masking a real status update from the next poll.
  useEffect(() => {
    setStatusOverride(null);
  }, [server.tunnelStatus]);

  // Close the menu on outside click. Kept minimal — no focus trap, no
  // keyboard-arrow navigation. The menu is small and the dashboard row is
  // not a hot path for keyboard users.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const status: ServerRowStatus =
    statusOverride ?? server.tunnelStatus ?? "stopped";

  const canReconnect = status === "error" || status === "stopped" || status === "ready";
  const canStop = status === "ready";
  const canStart = status === "stopped";

  async function runTunnelAction(path: string, optimistic: ServerRowStatus | null) {
    setMenuOpen(false);
    if (optimistic) setStatusOverride(optimistic);
    try {
      await apiFetch(path, { method: "POST" });
      // Clear the override on success too: the parent's refetch (kicked off
      // by onChanged) is the authoritative source of the new status. If the
      // refetch lands with the same value as before the click, we still want
      // to drop the override instead of pinning the dot to "starting".
      setStatusOverride(null);
      onChanged?.();
    } catch {
      // Roll back the optimistic override so the dot snaps back to whatever
      // the prop says. The parent's next poll will reconcile the truth.
      setStatusOverride(null);
    }
  }

  async function handleRemove() {
    setMenuOpen(false);
    setRemoved(true);
    try {
      await apiFetch(`/meta/remote-servers/${server.id}`, { method: "DELETE" });
      onChanged?.();
    } catch {
      // Rollback: un-hide the row. The parent list still has the server in
      // its array, so simply rendering again is enough.
      setRemoved(false);
    }
  }

  if (removed) return null;

  const errorTooltip =
    status === "error" ? errorCodeMessage(server.errorCode) : undefined;

  return (
    <TableRow data-testid={`server-row-${server.id}`}>
      <TableCell className="w-[24px]">
        <span
          data-testid="status-dot"
          data-status={status}
          role="img"
          aria-label={`status: ${status}`}
          title={errorTooltip}
          className={cn(
            "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
            STATUS_DOT_CLASS[status],
          )}
        />
      </TableCell>
      <TableCell className="font-medium">{server.name}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {sshHostSummary(server)}
      </TableCell>
      <TableCell className="w-[48px] text-right">
        <div ref={menuRef} className="relative inline-block">
          <button
            type="button"
            aria-label="Row actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <ul
              role="menu"
              aria-label="Server actions"
              className="absolute right-0 z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-sm shadow-md"
            >
              <li>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canReconnect}
                  onClick={() =>
                    void runTunnelAction(
                      `/meta/remote-servers/${server.id}/tunnel/restart`,
                      "starting",
                    )
                  }
                  className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  Reconnect
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canStop}
                  onClick={() =>
                    void runTunnelAction(
                      `/meta/remote-servers/${server.id}/tunnel/stop`,
                      "stopped",
                    )
                  }
                  className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  Stop
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canStart}
                  onClick={() =>
                    void runTunnelAction(
                      `/meta/remote-servers/${server.id}/tunnel/start`,
                      "starting",
                    )
                  }
                  className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  Start
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleRemove()}
                  className="flex w-full items-center rounded px-2 py-1.5 text-left text-destructive hover:bg-muted"
                >
                  Remove
                </button>
              </li>
            </ul>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
