import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { X } from "lucide-react";
import { PlanFileEditor } from "./PlanFileEditor";
import { PlanChatPanel } from "./PlanChatPanel";
import type { ChatContext } from "./types";

/**
 * Shared open/close controller for the Plan file-editor + chat modal.
 *
 * In the old tree-view surface the modal was owned by
 * {@link ProjectDetailTreeView} and triggered by chat buttons rendered
 * inside {@link MilestoneCard} / {@link SliceRow} / {@link TaskRow}. The
 * redesigned board-only layout has no tree-level chat buttons — the
 * equivalent trigger is an "Edit plan files" button on the right-rail
 * detail panels instead.
 *
 * To avoid prop-drilling the open/close callback through
 * `ProjectDetailBoardView` → `BoardRightDefault` → `SliceDetailTabs` →
 * `SliceDetailPanel` (and the parallel MilestoneDetailPanel path), we
 * publish the opener via React context. The provider owns:
 *   - `context` — which entity is currently being edited (null when
 *     closed);
 *   - `open(ctx)` — open the modal for a given milestone/slice/task;
 *   - `close()` — close the modal.
 *
 * The modal itself is rendered by the provider so callers never have to
 * import `PlanFileEditor` / `PlanChatPanel` directly.
 *
 * Consumers use {@link usePlanEditor} to read the controller. If no
 * provider is mounted (e.g. a storybook harness) the hook returns `null`
 * and callers MUST fall back to hiding the affordance — same contract
 * as the chat-draft store.
 */

export interface PlanEditorController {
  /** Currently open entity, or `null` when the modal is closed. */
  context: ChatContext | null;
  /** Open the modal for the supplied entity. */
  open: (context: ChatContext) => void;
  /** Close the modal. Safe to call when already closed. */
  close: () => void;
}

const PlanEditorContext = createContext<PlanEditorController | null>(null);

/**
 * Read the Plan-editor controller from context. Returns `null` when
 * the component is rendered outside a {@link PlanEditorProvider} — in
 * that case the caller MUST hide its "Edit plan files" affordance.
 */
export function usePlanEditor(): PlanEditorController | null {
  return useContext(PlanEditorContext);
}

export interface PlanEditorProviderProps {
  projectId: string;
  children: ReactNode;
}

/**
 * Provider that owns modal state and renders the Plan file-editor +
 * chat split-view dialog. Mount once per project-detail surface (Plan
 * tab). The modal stays visually identical to the old tree-view one —
 * this is a pure hoist, not a redesign.
 */
export function PlanEditorProvider({ projectId, children }: PlanEditorProviderProps) {
  const [context, setContext] = useState<ChatContext | null>(null);

  const open = useCallback((next: ChatContext) => setContext(next), []);
  const close = useCallback(() => setContext(null), []);

  const controller = useMemo<PlanEditorController>(
    () => ({ context, open, close }),
    [context, open, close],
  );

  return (
    <PlanEditorContext.Provider value={controller}>
      {children}
      <Dialog
        open={!!context}
        onOpenChange={(v) => {
          if (!v) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="!grid-cols-1 sm:!max-w-[95vw] !max-w-[95vw] !w-[95vw] !h-[90vh] !p-0 !gap-0 !flex !flex-col"
        >
          <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs capitalize">
                {context?.entity_type}
              </Badge>
              <span className="text-base font-semibold">{context?.title}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={close}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 min-w-0 border-r h-full">
              {context && (
                <PlanFileEditor projectId={projectId} context={context} />
              )}
            </div>
            <div className="w-[400px] shrink-0 h-full">
              {context && (
                <PlanChatPanel
                  // Remount on entity change so the panel re-resolves to the
                  // new entity's chatId from scratch — same rationale as
                  // ProjectDetailTreeView before the hoist.
                  key={`${context.entity_type}:${context.entity_id}`}
                  projectId={projectId}
                  context={context}
                  onClose={close}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PlanEditorContext.Provider>
  );
}
