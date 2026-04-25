import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Check, Loader2 } from "lucide-react";
import {
  useProjectTodo,
  useUpdateProjectTodo,
  useWorkspaceTodo,
  useUpdateWorkspaceTodo,
} from "@/lib/hooks";

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
}

interface ProjectProps extends BaseProps {
  scope: "project";
  projectId: string;
}

interface WorkspaceProps extends BaseProps {
  scope: "workspace";
  workspaceId: string;
}

export type TodoMdDialogProps = ProjectProps | WorkspaceProps;

const AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * Dialog for editing the root-level TODO.md of a project or workspace.
 * Always shows a textarea — no view/edit mode toggle, no Save button.
 * Edits are auto-saved on a debounce (`AUTOSAVE_DEBOUNCE_MS`) and the
 * dialog flushes the pending write on close so nothing is lost.
 *
 * The scope prop picks which query + mutation pair to use so a single
 * component can back both the project and the workspace call sites.
 */
export function TodoMdDialog(props: TodoMdDialogProps) {
  const { open, onOpenChange, title } = props;

  // Hooks are declared unconditionally; the opposite scope stays disabled.
  const projectQuery = useProjectTodo(
    props.scope === "project" ? props.projectId : "",
    { enabled: open && props.scope === "project" },
  );
  const workspaceQuery = useWorkspaceTodo(
    props.scope === "workspace" ? props.workspaceId : "",
    { enabled: open && props.scope === "workspace" },
  );
  const updateProject = useUpdateProjectTodo();
  const updateWorkspace = useUpdateWorkspaceTodo();

  const query = props.scope === "project" ? projectQuery : workspaceQuery;
  const data = query.data;
  const isLoading = query.isLoading;

  const isSaving =
    props.scope === "project" ? updateProject.isPending : updateWorkspace.isPending;

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Tracks the last content we successfully persisted to the server so we can
  // suppress an autosave immediately after a fresh load (draft === server).
  const savedContentRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the draft whenever the dialog opens or the server copy changes — we
  // never want to silently carry a stale draft across reopens.
  useEffect(() => {
    if (!open) return;
    const serverContent = data?.content ?? "";
    setDraft(serverContent);
    savedContentRef.current = serverContent;
    setError(null);
  }, [open, data?.content]);

  // Persist the current draft. Pulled out so both the debounced autosave
  // and the on-close flush can share the same code path.
  async function persist(content: string) {
    if (content === savedContentRef.current) return;
    setError(null);
    try {
      if (props.scope === "project") {
        await updateProject.mutateAsync({ projectId: props.projectId, content });
      } else {
        await updateWorkspace.mutateAsync({
          workspaceId: props.workspaceId,
          content,
        });
      }
      savedContentRef.current = content;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save TODO.md");
    }
  }

  // Debounced autosave. Fires `AUTOSAVE_DEBOUNCE_MS` after the user stops
  // typing. The ref tracks the most recent persisted content so we skip the
  // trivial "draft equals server" case that fires right after opening.
  useEffect(() => {
    if (!open) return;
    if (draft === savedContentRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void persist(draft);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // persist is stable enough for this pattern; adding it would cause a
    // re-run on every mutation state flip and defeat the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, open]);

  // Flush any pending edits synchronously on close so closing the dialog
  // mid-debounce doesn't drop the last keystrokes.
  function handleOpenChange(next: boolean) {
    if (!next) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (draft !== savedContentRef.current) {
        void persist(draft);
      }
    }
    onOpenChange(next);
  }

  const dirty = draft !== savedContentRef.current;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[90vh] max-h-[90vh] w-[calc(100vw-1rem)] max-w-[min(96vw,1280px)] flex-col overflow-hidden sm:h-[85vh] sm:max-h-[85vh] sm:max-w-[min(92vw,1280px)] lg:max-w-[min(88vw,1400px)]">
        <DialogHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <DialogTitle>{title} — TODO.md</DialogTitle>
              {data?.path && (
                <DialogDescription className="truncate font-mono text-xs">
                  {data.path}
                </DialogDescription>
              )}
            </div>
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Saving…
                </>
              ) : dirty ? (
                <span className="opacity-60">Unsaved</span>
              ) : (
                <>
                  <Check className="h-3 w-3" />
                  Saved
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 resize-none font-mono text-sm"
              placeholder="# TODO&#10;&#10;- [ ] First item"
              spellCheck={false}
              autoFocus
            />
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
