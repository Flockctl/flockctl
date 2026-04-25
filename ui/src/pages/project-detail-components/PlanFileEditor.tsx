import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { usePlanFile, useUpdatePlanFile } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, Save } from "lucide-react";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import type { ChatContext } from "./types";

// --- Plan File Editor ---

export function PlanFileEditor({
  projectId,
  context,
}: {
  projectId: string;
  context: ChatContext;
}) {
  const fileParams = {
    type: context.entity_type,
    milestone: context.entity_type === "milestone" ? context.entity_id
      : context.milestone_id,
    slice: context.entity_type === "slice" ? context.entity_id
      : context.slice_id,
    task: context.entity_type === "task" ? context.entity_id : undefined,
  };

  const { data: fileData, isLoading, error } = usePlanFile(projectId, fileParams);
  const updateFile = useUpdatePlanFile(projectId);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");

  const isDark = useMemo(() => {
    if (typeof window === "undefined") return false;
    return document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  }, []);

  const handleSave = useCallback(async () => {
    await updateFile.mutateAsync({ ...fileParams, content: contentRef.current });
    setDirty(false);
  }, [fileParams, updateFile]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // Create editor once when container is ready
  useEffect(() => {
    if (!editorRef.current) return;

    const extensions = [
      basicSetup,
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          contentRef.current = update.state.doc.toString();
          setDirty(true);
        }
      }),
      keymap.of([{
        key: "Mod-s",
        run: () => { handleSaveRef.current(); return true; },
      }]),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        },
        ".cm-content": {
          padding: "12px 0",
        },
        ".cm-gutters": {
          borderRight: "1px solid var(--border, #e5e7eb)",
          backgroundColor: "transparent",
        },
      }),
    ];

    if (isDark) {
      extensions.push(oneDark);
    }

    const state = EditorState.create({
      doc: fileData?.content ?? "",
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    contentRef.current = fileData?.content ?? "";

    return () => {
      view.destroy();
      viewRef.current = null;
    };
     
  }, [isDark, fileData?.content]);

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load file</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">
          {fileData?.path?.split("/").slice(-3).join("/") ?? ""}
        </span>
        {dirty && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            disabled={updateFile.isPending}
            onClick={handleSave}
          >
            {updateFile.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </Button>
        )}
      </div>
      <div ref={editorRef} className="flex-1 overflow-hidden" />
    </div>
  );
}
