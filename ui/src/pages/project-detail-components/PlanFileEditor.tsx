import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { usePlanFile, useUpdatePlanFile } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, Save } from "lucide-react";
import { CodeEditor } from "@/components/CodeEditor";
import type { ChatContext } from "./types";

// --- Plan File Editor ---
//
// Surfaces the plan markdown file (milestone.md / slice.md / task.md) for the
// entity currently selected in the plan-editor dialog. The editor itself is
// the shared Monaco wrapper (`<CodeEditor>`) — same component the AGENTS.md
// editor uses, so the look-and-feel, theme support, and Cmd+S binding match
// across the app.
//
// Read + write paths still go through the legacy plan-store endpoints
// (`GET/PUT /projects/:id/plan-file`). Those endpoints don't return a sha,
// so this editor doesn't ship the optimistic-conflict banner the AGENTS.md
// editor has — there's nothing to compare against. Once the plan-file API
// is unified onto the FS endpoints (M01), we can fold this onto
// `useProjectFile` / `useSaveProjectFile` and bring the conflict UX with it.
//
// TODO M01: standardise on FS API only — replace usePlanFile /
// useUpdatePlanFile with useProjectFile / useSaveProjectFile, then re-use
// the AgentsMdEditor sha-conflict banner.

export function PlanFileEditor({
  projectId,
  context,
}: {
  projectId: string;
  context: ChatContext;
}) {
  const fileParams = useMemo(
    () => ({
      type: context.entity_type,
      milestone:
        context.entity_type === "milestone"
          ? context.entity_id
          : context.milestone_id,
      slice:
        context.entity_type === "slice" ? context.entity_id : context.slice_id,
      task: context.entity_type === "task" ? context.entity_id : undefined,
    }),
    [
      context.entity_type,
      context.entity_id,
      context.milestone_id,
      context.slice_id,
    ],
  );

  const { data: fileData, isLoading, error } = usePlanFile(projectId, fileParams);
  const updateFile = useUpdatePlanFile(projectId);

  // Live source (last value the server confirmed) and draft (the editor
  // buffer). Dirty == they disagree. Initialised lazily once `fileData`
  // resolves; the source-sync effect below resets the draft whenever the
  // selected entity changes so flipping between milestone → slice → task
  // doesn't leak the prior buffer's content.
  const [source, setSource] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [saved, setSaved] = useState(false);

  const resetKey = `${context.entity_type}:${context.entity_id}`;
  const lastResetKey = useRef<string>(resetKey);
  const lastContent = useRef<string>("");
  useEffect(() => {
    const incoming = fileData?.content ?? "";
    if (
      lastResetKey.current !== resetKey ||
      lastContent.current !== incoming
    ) {
      lastResetKey.current = resetKey;
      lastContent.current = incoming;
      setSource(incoming);
      setDraft(incoming);
    }
  }, [resetKey, fileData?.content]);

  const dirty = draft !== source;
  const isSaving = updateFile.isPending;

  const handleSave = useCallback(async () => {
    if (!dirty || isSaving) return;
    try {
      await updateFile.mutateAsync({ ...fileParams, content: draft });
      setSource(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      // Surfaced through the mutation hook's error state — nothing more to do
      // here. The legacy endpoint doesn't have a sha-conflict path, so any
      // failure is genuinely a server error rather than a contention case.
    }
    // `fileParams` is recreated on every render but only changes when
    // `context` changes; depending on the freshly-built object would
    // re-bind every keystroke. Capture the relevant scalars instead.
  }, [dirty, draft, fileParams, isSaving, updateFile]);

  // Cmd/Ctrl+S — Monaco's `editor.addCommand` registers a global handler
  // that intercepts the browser's Save dialog while the editor has focus.
  // The save closure is captured by ref so the binding doesn't need to be
  // re-registered every keystroke.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSaveRef.current();
    });
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">Failed to load file</div>
    );
  }

  const filePath = fileData?.path ?? "";
  // Surface the trailing path segments (e.g. "00-foo/milestone.md") — same
  // truncation rule the previous CodeMirror surface used.
  const displayPath = filePath.split("/").slice(-3).join("/");

  return (
    <div className="flex h-full flex-col" data-testid="plan-file-editor">
      <div className="flex items-center gap-2 border-b p-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono"
          data-testid="plan-file-editor-path"
        >
          {displayPath}
        </span>
        {dirty && (
          <Badge
            variant="outline"
            className="border-amber-500 text-amber-600"
            data-testid="plan-file-editor-dirty"
          >
            Unsaved
          </Badge>
        )}
        {saved && (
          <Badge
            variant="outline"
            className="border-green-500 text-green-600"
            data-testid="plan-file-editor-saved"
          >
            Saved
          </Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={!dirty || isSaving}
          aria-disabled={!dirty || isSaving}
          aria-label={
            !dirty
              ? "Save disabled: no changes"
              : isSaving
                ? "Saving in progress"
                : "Save plan file"
          }
          onClick={() => {
            void handleSave();
          }}
        >
          {isSaving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
      <div
        className="flex-1 overflow-hidden"
        data-testid="plan-file-editor-surface"
      >
        <CodeEditor
          language="markdown"
          path={filePath || "plan.md"}
          value={draft}
          onChange={setDraft}
          onMount={handleEditorMount}
          height="100%"
        />
      </div>
    </div>
  );
}
