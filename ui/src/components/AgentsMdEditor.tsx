import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OnMount } from "@monaco-editor/react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeEditor } from "@/components/CodeEditor";

// Hoisted style literal (audit-round-7): `style={{ height: 320 }}`
// inside the JSX re-allocates the object on every parent render and
// breaks downstream memoization of `<CodeEditor>`. Module scope makes
// it a stable reference for the lifetime of the module.
const EDITOR_SURFACE_STYLE = { height: 320 } as const;
import {
  useProjectEffective,
  usePutProjectAgentsMd,
  useWorkspaceEffective,
  usePutWorkspaceAgentsMd,
} from "@/lib/hooks";
import {
  projectFileQueryKey,
  useProjectFile,
  useWorkspaceFile,
  workspaceFileQueryKey,
} from "@/lib/hooks/fs";
import {
  fetchProjectFile,
  fetchWorkspaceFile,
  type FsReadResponse,
} from "@/lib/api/fs";
import type {
  Effective,
  ProjectLayer,
  WorkspaceLayer,
} from "@/lib/types/agents-md";
import { Save, ChevronDown, ChevronRight, Plus } from "lucide-react";

// --- AgentsMdEditor ---
//
// Flat editor for the scope's public AGENTS.md. Private layers were retired
// (see docs/AGENTS-LAYERING.md); each scope now owns exactly one editable
// file. A read-only accordion below the editor surfaces the merged
// `mergedWithHeaders` preview produced by `/agents-md/effective` so users
// can still see how the user / workspace / project layers stack up.
//
// Save is always explicit (no autosave). The byte counter turns yellow at
// 200 KiB and red at 256 KiB; the Save button is hard-disabled above the
// 256 KiB boundary to match the server-side limit (PUT returns 413).
//
// Read path uses the entity's `/fs/file?path=AGENTS.md` endpoint via
// `useProjectFile` / `useWorkspaceFile` — the editor renders Monaco with
// the file's live UTF-8 contents. Save still flows through the legacy
// `usePut*AgentsMd` mutations (slice 01 owns the unified write path).

// --- Byte-limit constants (match backend) ---

export const SOFT_BYTE_WARN = 200 * 1024; // yellow
export const HARD_BYTE_LIMIT = 256 * 1024; // red / save-blocked

// --- Types ---

type Scope = "project" | "workspace";

const LAYER_FOR_SCOPE: Record<Scope, ProjectLayer | WorkspaceLayer> = {
  project: "project-public",
  workspace: "workspace-public",
};

const EMPTY_HINT: Record<Scope, string> = {
  project: "committed to the repo for this project",
  workspace: "shared across every project in the workspace",
};

const AGENTS_MD_PATH = "AGENTS.md";

// --- Helpers ---

function byteLen(s: string): number {
  // TextEncoder is available in jsdom and browsers; guard for tests that
  // stub the global.
  if (typeof TextEncoder === "undefined") return s.length;
  return new TextEncoder().encode(s).length;
}

/** Extract a best-effort HTTP status from an unknown error value. */
export function extractStatus(err: unknown): number | null {
  if (err == null) return null;
  if (typeof err === "number") return err;
  if (typeof err === "object") {
    const e = err as { status?: unknown; response?: { status?: unknown }; message?: unknown };
    if (typeof e.status === "number") return e.status;
    if (e.response && typeof e.response.status === "number") return e.response.status;
    if (typeof e.message === "string") {
      const m = e.message.match(/\b(4\d{2}|5\d{2})\b/);
      if (m && m[1]) return parseInt(m[1], 10);
    }
  }
  return null;
}

// --- Read-state derivation -------------------------------------------------
//
// `useProjectFile` / `useWorkspaceFile` resolve to a discriminated envelope
// (`{ ok: true | false }`). Collapse that into a single load-state the rest
// of the component renders against. `creating new` is the legitimate "no
// file on disk yet" branch — the daemon answers HTTP 200 with
// `{ ok: false, error_code: "fs_not_found" }`, NOT a thrown 404.

type LoadStatus = "loading" | "loaded" | "creating new" | "error" | "forbidden";

interface ReadState {
  status: LoadStatus;
  /** Server-side content when present; empty string otherwise. */
  source: string;
  /** True iff the file exists on disk. */
  present: boolean;
  /** Best-effort message for the "error" branch only. */
  errorMessage?: string;
}

function deriveReadState(
  isLoading: boolean,
  data: FsReadResponse | undefined,
  error: unknown,
): ReadState {
  if (error) {
    if (extractStatus(error) === 403) {
      return { status: "forbidden", source: "", present: false };
    }
    return {
      status: "error",
      source: "",
      present: false,
      errorMessage:
        error instanceof Error ? error.message : "Failed to load AGENTS.md",
    };
  }
  if (isLoading || !data) {
    return { status: "loading", source: "", present: false };
  }
  if (data.ok === true) {
    return { status: "loaded", source: data.content, present: true };
  }
  // ok === false: distinguish "not present yet" from genuine errors.
  if (
    data.error_code === "fs_not_found" ||
    data.error_code === "fs_no_project_path" ||
    data.error_code === "fs_missing_path"
  ) {
    return { status: "creating new", source: "", present: false };
  }
  if (data.error_code === "fs_permission_denied") {
    return { status: "forbidden", source: "", present: false };
  }
  return {
    status: "error",
    source: "",
    present: false,
    errorMessage: data.message ?? data.error_code,
  };
}

const STATUS_LABEL: Record<LoadStatus, string> = {
  loading: "loading",
  loaded: "loaded",
  "creating new": "creating new",
  error: "error",
  forbidden: "forbidden",
};

// --- Effective preview accordion ---

function EffectivePreview({ data }: { data: Effective | undefined }) {
  const [open, setOpen] = useState(false);
  const layers = data?.layers ?? [];
  const merged = data?.mergedWithHeaders ?? "";
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={open}
        aria-controls="agents-md-effective-preview"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Effective preview — what agents read (read-only)
      </button>

      {open && (
        <div
          id="agents-md-effective-preview"
          data-testid="agents-md-effective-preview"
          className="rounded border bg-muted/40 px-3 py-2 text-xs font-mono overflow-auto max-h-96"
        >
          {layers.length === 0 ? (
            <span className="italic text-muted-foreground">
              No guidance. Agents will fall back to built-in defaults.
            </span>
          ) : (
            <pre className="whitespace-pre-wrap">{merged}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// --- Minimal, accessible toast ---

interface ToastState {
  id: number;
  kind: "info" | "error";
  message: string;
}

function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastState[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      data-testid="agents-md-toast-region"
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          data-testid={`agents-md-toast-${t.kind}`}
          className={`pointer-events-auto rounded border px-3 py-2 text-sm shadow ${
            t.kind === "error"
              ? "border-destructive bg-destructive/10 text-destructive"
              : "border-border bg-background"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{t.message}</span>
            <button
              type="button"
              className="text-xs opacity-60 hover:opacity-100"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(t.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Public component ---

export interface AgentsMdEditorProps {
  scope: Scope;
  id: string;
  title?: string;
  description?: string;
}

export function AgentsMdEditor({
  scope,
  id,
  title = scope === "workspace"
    ? "Agent documentation (workspace)"
    : "Agent documentation",
  description,
}: AgentsMdEditorProps) {
  // --- Read path: GET /:scope/:id/fs/file?path=AGENTS.md -------------------
  //
  // The two hooks are gated on `scope`: only one ever has `enabled: true`
  // for a given mount, so we don't double-fetch.
  const projectFile = useProjectFile(
    scope === "project" ? id : "",
    scope === "project" ? AGENTS_MD_PATH : null,
  );
  const workspaceFile = useWorkspaceFile(
    scope === "workspace" ? id : "",
    scope === "workspace" ? AGENTS_MD_PATH : null,
  );
  const fileQuery = scope === "project" ? projectFile : workspaceFile;

  const projectEffective = useProjectEffective(scope === "project" ? id : "");
  const workspaceEffective = useWorkspaceEffective(scope === "workspace" ? id : "");
  const effective = scope === "project" ? projectEffective : workspaceEffective;

  // --- Save path: unchanged from the previous slice. ------------------------
  const putProject = usePutProjectAgentsMd();
  const putWorkspace = usePutWorkspaceAgentsMd();

  const layerKey = LAYER_FOR_SCOPE[scope];

  // --- Toasts ---
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((kind: ToastState["kind"], message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const [saved, setSaved] = useState(false);
  const handleSaved = useCallback(() => {
    setSaved(true);
    pushToast("info", "Saved.");
    setTimeout(() => setSaved(false), 2500);
  }, [pushToast]);

  const handleSaveError = useCallback(
    (err: unknown) => {
      const status = extractStatus(err);
      if (status === 413) {
        pushToast(
          "error",
          "Save failed: content is larger than the 256 KiB limit.",
        );
        return;
      }
      if (status === 403) {
        pushToast("error", "Save failed: you don't have permission.");
        return;
      }
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Save failed.";
      pushToast("error", msg);
    },
    [pushToast],
  );

  // --- Resolve load state. -------------------------------------------------
  const readState = deriveReadState(
    fileQuery.isLoading,
    fileQuery.data,
    fileQuery.error,
  );
  const { status: loadStatus, source, present, errorMessage } = readState;
  const forbidden = loadStatus === "forbidden";

  // --- Draft state (must live outside conditional early returns) ---
  const [draft, setDraft] = useState(source);
  const [materialized, setMaterialized] = useState(present);

  // Held sha — the sha we believe the on-disk file has. Initialized from
  // the loaded fs/file response and advanced after every successful save.
  // When the held sha disagrees with the latest sha at save time, another
  // writer beat us; we surface a conflict banner instead of overwriting.
  const initialSha = fileQuery.data && fileQuery.data.ok ? fileQuery.data.sha : "";
  const [heldSha, setHeldSha] = useState<string>(initialSha);

  const resetKey = `${scope}:${id}`;
  const lastResetKey = useRef<string>(resetKey);
  const lastSource = useRef<string>(source);
  const lastSha = useRef<string>(initialSha);
  useEffect(() => {
    const incomingSha =
      fileQuery.data && fileQuery.data.ok ? fileQuery.data.sha : "";
    if (
      lastResetKey.current !== resetKey ||
      lastSource.current !== source ||
      lastSha.current !== incomingSha
    ) {
      lastResetKey.current = resetKey;
      lastSource.current = source;
      lastSha.current = incomingSha;
      setDraft(source);
      setMaterialized(present);
      setHeldSha(incomingSha);
    }
  }, [resetKey, source, present, fileQuery.data]);

  const dirty = draft !== source;
  const bytes = byteLen(draft);
  const overHard = bytes > HARD_BYTE_LIMIT;
  const overSoft = bytes > SOFT_BYTE_WARN;
  const isSaving = putProject.isPending || putWorkspace.isPending;

  // --- Conflict state ------------------------------------------------------
  //
  // A non-null `conflict` means: at save time we observed a sha on disk that
  // differs from `heldSha`, i.e. another tab / agent / editor wrote to
  // AGENTS.md while the user was typing here. Save is blocked until the user
  // resolves it via the banner — Reload (discard our edits, pull theirs) or
  // Keep mine (advance heldSha so the next save deliberately overwrites).
  const [conflict, setConflict] = useState<{ currentSha: string } | null>(null);

  const queryClient = useQueryClient();

  const fileKey =
    scope === "project"
      ? projectFileQueryKey(id, AGENTS_MD_PATH)
      : workspaceFileQueryKey(id, AGENTS_MD_PATH);

  const fetchFile = useCallback((): Promise<FsReadResponse> => {
    return scope === "project"
      ? fetchProjectFile(id, AGENTS_MD_PATH)
      : fetchWorkspaceFile(id, AGENTS_MD_PATH);
  }, [scope, id]);

  const saveLayer = useCallback(async () => {
    // Hard limit guard — the Save button is also disabled in this state, but
    // the keyboard shortcut bypasses the disabled state on the button.
    if (overHard || isSaving) return;
    setConflict(null);

    // 1) Optimistic conflict detection: refetch the latest file and compare
    //    its sha against the one we hold. We only treat a mismatch as a
    //    conflict when both sides have a sha — a fresh "creating new" save
    //    legitimately starts with empty heldSha and no on-disk file.
    let latest: FsReadResponse;
    try {
      latest = await fetchFile();
    } catch (err) {
      handleSaveError(err);
      return;
    }
    const latestSha = latest.ok ? latest.sha : "";
    if (heldSha && latestSha && latestSha !== heldSha) {
      setConflict({ currentSha: latestSha });
      return;
    }

    // 2) No conflict — write through the existing PUT mutation.
    try {
      if (scope === "project") {
        await putProject.mutateAsync({ projectId: id, content: draft });
      } else {
        await putWorkspace.mutateAsync({ workspaceId: id, content: draft });
      }
    } catch (err) {
      handleSaveError(err);
      return;
    }

    // 3) Refresh our local snapshot of the file so source/draft re-align,
    //    the dirty badge clears, and heldSha advances to the just-written
    //    version. Pushing the fresh response straight into the React Query
    //    cache (rather than just invalidating) avoids a one-frame flicker
    //    where source still points at the previous content.
    setMaterialized(true);
    try {
      const after = await fetchFile();
      queryClient.setQueryData(fileKey, after);
      if (after.ok) setHeldSha(after.sha);
    } catch {
      // The follow-up GET is best-effort — fall back to a cache invalidation
      // so the next render still picks up fresh content.
      void queryClient.invalidateQueries({ queryKey: fileKey });
    }
    handleSaved();
  }, [
    scope,
    id,
    draft,
    heldSha,
    overHard,
    isSaving,
    putProject,
    putWorkspace,
    handleSaved,
    handleSaveError,
    fetchFile,
    queryClient,
    fileKey,
  ]);

  // Cmd/Ctrl+S — Monaco's `editor.addCommand` registers a global handler that
  // intercepts the browser's Save dialog while the editor has focus. The
  // saveLayer closure is captured by ref so the binding doesn't need to be
  // re-registered every keystroke.
  const saveLayerRef = useRef(saveLayer);
  useEffect(() => {
    saveLayerRef.current = saveLayer;
  }, [saveLayer]);
  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveLayerRef.current();
    });
  }, []);

  // --- Conflict resolution handlers ----------------------------------------
  const reloadFromDisk = useCallback(async () => {
    // Pull the latest content + sha and let the source-sync effect reset the
    // editor's draft to it. Invalidating drives a refetch through
    // `useProjectFile` / `useWorkspaceFile`; the effect above swaps draft and
    // heldSha as soon as the new data lands.
    setConflict(null);
    await queryClient.invalidateQueries({ queryKey: fileKey });
  }, [queryClient, fileKey]);

  const keepMyEdits = useCallback(() => {
    if (!conflict) return;
    // Advance heldSha so the next save passes the conflict check and
    // intentionally overwrites whatever is on disk now. The Monaco buffer is
    // left untouched — the user's edits remain in the draft.
    setHeldSha(conflict.currentSha);
    setConflict(null);
  }, [conflict]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && (
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          )}
        </CardHeader>
        <CardContent>
          <div
            role="alert"
            data-testid="agents-md-forbidden"
            className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
          >
            You don't have permission to edit{" "}
            {scope === "project" ? "this project's" : "this workspace's"} agent
            guidance.
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loadStatus === "loading") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (loadStatus === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            Failed to load agent guidance:{" "}
            {errorMessage ?? "unknown error"}
          </p>
        </CardContent>
      </Card>
    );
  }

  const saveDisabled = !dirty || isSaving || overHard;
  const counterClass = overHard
    ? "text-destructive"
    : overSoft
      ? "text-amber-600"
      : "text-muted-foreground";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && (
              <p className="text-xs text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          {saved && (
            <Badge
              variant="outline"
              className="border-green-500 text-green-600"
            >
              Saved
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Empty state: no AGENTS.md yet for this scope. */}
        {!materialized && !dirty ? (
          <div
            data-testid={`agents-md-empty-${layerKey}`}
            className="flex flex-col items-start gap-3 rounded border border-dashed bg-muted/30 px-4 py-6"
          >
            <p className="text-sm text-muted-foreground">
              No agent guidance yet. Add rules that apply to{" "}
              <span className="font-medium">{EMPTY_HINT[scope]}</span>.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMaterialized(true);
                setDraft("# Agent guidance\n\n");
              }}
              data-testid={`agents-md-create-${layerKey}`}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Create
            </Button>
          </div>
        ) : (
          <>
            {/* Conflict banner — surfaces when another writer modified
                AGENTS.md on disk while the user was editing here. Two
                resolutions: pull theirs (Reload from disk) or stage to
                overwrite on next save (Keep my edits). The banner sits above
                the editor surface so it isn't hidden behind a long file. */}
            {conflict && (
              <div
                role="alert"
                data-testid="agents-md-conflict-banner"
                className="rounded border border-amber-500 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm"
              >
                <p className="text-amber-700 dark:text-amber-400">
                  AGENTS.md changed on disk while you were editing. Save was
                  blocked to prevent overwriting another edit.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="agents-md-conflict-reload"
                    onClick={() => {
                      void reloadFromDisk();
                    }}
                  >
                    Reload from disk
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="agents-md-conflict-keep"
                    onClick={keepMyEdits}
                  >
                    Keep my edits
                  </Button>
                </div>
              </div>
            )}

            {/* Header strip: file path + read status. The status reflects the
                /fs/file fetch — once a draft has diverged from disk, it stays
                "loaded" / "creating new"; the dirty Badge below the editor
                signals unsaved changes separately. */}
            <div
              data-testid={`agents-md-editor-header-${layerKey}`}
              className="flex items-center justify-between gap-2 rounded-t border border-b-0 bg-muted/40 px-3 py-1.5 text-xs"
            >
              <span
                className="font-mono text-muted-foreground"
                data-testid={`agents-md-path-${layerKey}`}
              >
                {AGENTS_MD_PATH}
              </span>
              <span
                className="text-muted-foreground"
                data-testid={`agents-md-status-${layerKey}`}
              >
                {STATUS_LABEL[loadStatus]}
              </span>
            </div>
            <div
              data-testid="agents-md-editor-surface"
              className="rounded-b border bg-background overflow-hidden"
              style={EDITOR_SURFACE_STYLE}
            >
              <CodeEditor
                language="markdown"
                path={AGENTS_MD_PATH}
                value={draft}
                onChange={setDraft}
                onMount={handleEditorMount}
                height="100%"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div
                data-testid={`agents-md-byte-counter-${layerKey}`}
                className={`text-xs font-mono ${counterClass}`}
                aria-live="polite"
                aria-atomic="true"
              >
                {bytes.toLocaleString()} bytes
                {overHard && (
                  <span className="ml-2 font-semibold">
                    — exceeds 256 KiB limit. Trim before saving.
                  </span>
                )}
                {!overHard && overSoft && (
                  <span className="ml-2">— approaching 256 KiB limit.</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {dirty && (
                  <Badge
                    variant="outline"
                    className="border-amber-500 text-amber-600"
                  >
                    Unsaved
                  </Badge>
                )}
                <Button
                  size="sm"
                  onClick={saveLayer}
                  disabled={saveDisabled}
                  aria-disabled={saveDisabled}
                  aria-label={
                    saveDisabled
                      ? overHard
                        ? "Save disabled: content exceeds 256 KiB"
                        : isSaving
                          ? "Saving in progress"
                          : "Save disabled: no changes"
                      : "Save agent guidance"
                  }
                >
                  <Save className="mr-1.5 h-4 w-4" />
                  {isSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </>
        )}

        <EffectivePreview data={effective.data} />
      </CardContent>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </Card>
  );
}

export default AgentsMdEditor;
