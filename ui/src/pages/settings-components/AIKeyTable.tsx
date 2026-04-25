import { useState } from "react";
import {
  useUpdateAIKey,
  useDeleteAIKey,
  useAIKeyIdentity,
} from "@/lib/hooks";
import type {
  AIProviderKeyResponse,
  AIKeyIdentityResponse,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Zap, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

// --- AI Key Table ---
//
// Each row owns its own `useAIKeyIdentity(keyId)` query via <AIKeyRow/>.
// Why a per-row sub-component rather than the parent looping and caching?
//  - React-query caches on the query key, so the Account column survives
//    route changes / tab switches without refetching.
//  - The Verify button triggers `refetch()`; there is no component-local
//    "failed once, stuck red forever" state like the old useMutation +
//    useState combo had (which is the bug this refactor fixes).
//  - Extracting the row is the only legal way to call a hook per row —
//    React forbids hooks inside `.map()` in the parent.

export function AIKeyTable({
  keys,
  isLoading,
  error,
}: {
  keys: AIProviderKeyResponse[] | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const deleteKey = useDeleteAIKey();
  const deleteConfirm = useConfirmDialog();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load keys: {error.message}
      </p>
    );
  }

  if (!keys || keys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No Claude Code keys configured yet.</p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Config Dir</TableHead>
            <TableHead>Credentials</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[210px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key: AIProviderKeyResponse) => (
            <AIKeyRow
              key={key.id}
              entry={key}
              onRequestDelete={() => deleteConfirm.requestConfirm(key.id)}
              isDeletePending={deleteKey.isPending}
            />
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Claude Code Key"
        description="This will permanently delete this key. Workers using it will no longer receive credentials for authentication. This action cannot be undone."
        isPending={deleteKey.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteKey.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </>
  );
}

// ─── AIKeyRow ────────────────────────────────────────────────────────────
//
// One table row. Owns:
//   - Inline rename state (`editingId` equivalent, scoped to this row).
//   - The Account column query (auto-fires on mount, 5-min staleTime).
//   - Per-row Update / Delete mutations.
//
// The parent passes the delete-confirm callback so a single <ConfirmDialog/>
// lives at the table level, not one per row.

function AIKeyRow({
  entry,
  onRequestDelete,
  isDeletePending,
}: {
  entry: AIProviderKeyResponse;
  onRequestDelete: () => void;
  isDeletePending: boolean;
}) {
  const updateKey = useUpdateAIKey();
  // Identity lookup is only meaningful for claude_cli keys — github_copilot
  // and other providers surface `supported:false` from the backend, but
  // there's no reason to even fire the request for them.
  const isClaudeCli =
    entry.provider === "claude_cli" || entry.cli_command !== null;
  const identityQuery = useAIKeyIdentity(entry.id, { enabled: isClaudeCli });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");

  function startEdit() {
    setEditName(entry.name ?? entry.label ?? "");
    setIsEditing(true);
  }

  function commitEdit() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== (entry.name ?? entry.label ?? "")) {
      updateKey.mutate({ keyId: entry.id, data: { label: trimmed } });
    }
    setIsEditing(false);
  }

  return (
    <TableRow>
      <TableCell className="text-sm">
        {isEditing ? (
          <Input
            autoFocus
            className="h-7 text-sm"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setIsEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="cursor-pointer rounded px-1 -mx-1 hover:bg-muted transition-colors text-left"
            onClick={startEdit}
            title="Click to rename"
          >
            {entry.name ?? entry.label ?? (
              <span className="text-muted-foreground italic">unnamed</span>
            )}
          </button>
        )}
      </TableCell>
      <TableCell>
        {entry.config_dir ? (
          <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
            {entry.config_dir}
          </code>
        ) : (
          <span className="text-xs text-muted-foreground">default</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="gap-1">
          <Zap className="h-3 w-3" />
          {entry.key_suffix ? "OAuth" : "Local auth"}
        </Badge>
      </TableCell>
      <TableCell className="text-xs">
        <IdentityCell
          enabled={isClaudeCli}
          isFetching={identityQuery.isFetching}
          data={identityQuery.data}
          queryError={identityQuery.error}
        />
      </TableCell>
      <TableCell>
        {entry.is_active ? (
          <Badge className="bg-green-600 text-white dark:bg-green-700">Active</Badge>
        ) : (
          <Badge variant="destructive">Inactive</Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!isClaudeCli || identityQuery.isFetching}
            onClick={() => {
              identityQuery.refetch();
            }}
            title={
              isClaudeCli
                ? "Re-resolve the Anthropic account for this key"
                : "Identity lookup is only available for claude_cli keys"
            }
          >
            {identityQuery.isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Verify"
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={updateKey.isPending}
            onClick={() =>
              updateKey.mutate({
                keyId: entry.id,
                data: { is_active: !entry.is_active },
              })
            }
          >
            {entry.is_active ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            disabled={isDeletePending}
            onClick={onRequestDelete}
          >
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── IdentityCell ────────────────────────────────────────────────────────
//
// Renders one of five states inline in the "Account" column:
//   - disabled  → "— not applicable —"    (non-claude_cli keys)
//   - loading   → spinner                 (first fetch or refetch in flight)
//   - error     → "not logged in" / specific ACL / HTTP message
//   - resolved  → email + org + plan badges
//
// The component is now driven by a react-query result, not by a local
// useState map — that's the fix for the "sticky red" bug where a failed
// verify would persist even after the underlying auth was repaired.

function IdentityCell({
  enabled,
  isFetching,
  data,
  queryError,
}: {
  enabled: boolean;
  isFetching: boolean;
  data: AIKeyIdentityResponse | undefined;
  queryError: Error | null;
}) {
  if (!enabled) {
    return (
      <span className="text-muted-foreground italic">— not applicable —</span>
    );
  }

  // First fetch: no data yet and a request is in flight.
  if (isFetching && !data) {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        resolving…
      </span>
    );
  }

  // Query itself failed (network, 500, etc.) — separate from the payload's
  // own `loggedIn:false` path so users can tell "backend broke" from
  // "Claude CLI not authed here".
  if (queryError && !data) {
    return (
      <span className="flex items-start gap-1 text-destructive">
        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="break-words">{queryError.message}</span>
      </span>
    );
  }

  if (!data) {
    // Query disabled or not yet initiated — should be rare given
    // `enabled: true` default. Render a neutral placeholder.
    return <span className="text-muted-foreground italic">—</span>;
  }

  if (!data.supported) {
    return (
      <span className="text-muted-foreground" title={data.reason}>
        — not applicable —
      </span>
    );
  }

  if (!data.loggedIn) {
    return (
      <span className="flex items-start gap-1 text-destructive">
        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="break-words">
          {data.error ?? "not logged in"}
        </span>
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 font-mono text-xs">
        <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
        {data.email ?? "(unknown email)"}
      </span>
      <span className="text-muted-foreground">
        {data.organizationName ?? "—"}
        {data.organizationType ? (
          <>
            {" · "}
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              {humanOrgType(data.organizationType)}
            </Badge>
          </>
        ) : null}
        {data.rateLimitTier ? (
          <>
            {" · "}
            <span
              className="text-[10px]"
              title={`rate_limit_tier=${data.rateLimitTier}`}
            >
              {humanRateLimitTier(data.rateLimitTier)}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function humanOrgType(raw: string): string {
  // Anthropic uses snake_case identifiers — trim the `claude_` prefix and
  // title-case the remainder for a readable badge ("Max", "Team", etc.).
  const short = raw.replace(/^claude_/, "");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function humanRateLimitTier(raw: string): string {
  // `default_claude_max_20x` → `20x`, `default_claude_max_5x` → `5x`.
  const m = /([0-9]+x)$/.exec(raw);
  return m?.[1] ?? raw;
}
