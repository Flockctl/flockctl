import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useProjectAgentsMd,
  useProjectEffective,
  usePutProjectAgentsMd,
  useWorkspaceAgentsMd,
  useWorkspaceEffective,
  usePutWorkspaceAgentsMd,
} from "@/lib/hooks";
import type {
  Effective,
  LayerState,
  ProjectLayer,
  WorkspaceLayer,
} from "@/lib/types/agents-md";
import { Save, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";

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

// --- CodeMirror editor surface ---

function LayerEditor({
  value,
  onChange,
  onSave,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const isDark = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (
      document.documentElement.classList.contains("dark") ||
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
    );
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;

    const exts = [
      basicSetup,
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) {
          onChangeRef.current(u.state.doc.toString());
        }
      }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(!!readOnly),
      EditorView.theme({
        "&": { height: "280px", fontSize: "13px" },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        },
        ".cm-content": { padding: "12px 0" },
        ".cm-gutters": {
          borderRight: "1px solid var(--border, #e5e7eb)",
          backgroundColor: "transparent",
        },
      }),
    ];
    if (isDark) exts.push(oneDark);

    const state = EditorState.create({ doc: value, extensions: exts });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
     
  }, [value, isDark, readOnly]);

  return (
    <div
      ref={hostRef}
      data-testid="agents-md-editor-surface"
      className="rounded border bg-background"
    />
  );
}

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
  const projectQuery = useProjectAgentsMd(scope === "project" ? id : "");
  const workspaceQuery = useWorkspaceAgentsMd(scope === "workspace" ? id : "");
  const projectEffective = useProjectEffective(scope === "project" ? id : "");
  const workspaceEffective = useWorkspaceEffective(scope === "workspace" ? id : "");
  const putProject = usePutProjectAgentsMd();
  const putWorkspace = usePutWorkspaceAgentsMd();

  const query = scope === "project" ? projectQuery : workspaceQuery;
  const effective = scope === "project" ? projectEffective : workspaceEffective;

  const layerKey = LAYER_FOR_SCOPE[scope];
  const layersMap = (query.data?.layers ?? {}) as Record<string, LayerState>;
  const layerState = layersMap[layerKey];

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

  // --- 403 short-circuit: the user can't edit. Render a message in place
  //     of the editor instead of silently leaving it empty. ---
  const loadStatus = extractStatus(query.error);
  const forbidden = loadStatus === 403;

  // --- Draft state (must live outside conditional early returns) ---
  const present = !!layerState?.present;
  const source = layerState?.content ?? "";
  const [draft, setDraft] = useState(source);
  const [materialized, setMaterialized] = useState(present);

  const resetKey = `${scope}:${id}`;
  const lastResetKey = useRef<string>(resetKey);
  const lastSource = useRef<string>(source);
  useEffect(() => {
    if (lastResetKey.current !== resetKey || lastSource.current !== source) {
      lastResetKey.current = resetKey;
      lastSource.current = source;
      setDraft(source);
      setMaterialized(present);
    }
  }, [resetKey, source, present]);

  const dirty = draft !== source;
  const bytes = byteLen(draft);
  const overHard = bytes > HARD_BYTE_LIMIT;
  const overSoft = bytes > SOFT_BYTE_WARN;
  const isSaving = putProject.isPending || putWorkspace.isPending;

  const saveLayer = useCallback(async () => {
    try {
      if (scope === "project") {
        await putProject.mutateAsync({ projectId: id, content: draft });
      } else {
        await putWorkspace.mutateAsync({ workspaceId: id, content: draft });
      }
      setMaterialized(true);
      handleSaved();
    } catch (err) {
      handleSaveError(err);
    }
  }, [scope, id, draft, putProject, putWorkspace, handleSaved, handleSaveError]);

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

  if (query.isLoading) {
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

  if (query.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            Failed to load agent guidance:{" "}
            {query.error instanceof Error
              ? query.error.message
              : "unknown error"}
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
      <CardContent className="space-y-4">
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
            <LayerEditor
              value={source}
              onChange={setDraft}
              onSave={saveLayer}
            />
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
