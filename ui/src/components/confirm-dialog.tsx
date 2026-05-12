import { useState, useCallback, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /**
   * Body content. Accepts a string (renders inside Radix's
   * `DialogDescription`) or a ReactNode for multi-paragraph layouts —
   * e.g. {@link DiscardConfirm} prepends a "file is open in a dirty tab"
   * warning above the path + "cannot be undone" line. We render
   * `DialogDescription` only for the string variant so multi-paragraph
   * bodies don't double-wrap inside a `<p>`.
   */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  isPending?: boolean;
  /** Visual variant of the confirm button. Defaults to "destructive". */
  confirmVariant?: "destructive" | "default";
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  isPending = false,
  confirmVariant = "destructive",
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {typeof description === "string" ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            // Non-string body — caller owns its own paragraphs / layout,
            // and we sidestep `DialogDescription`'s implicit `<p>` wrap so
            // a child `<p>` doesn't produce an invalid hydration nest.
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? `${confirmLabel}...` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hook to manage confirm dialog state.
 * Returns [targetId, requestConfirm, confirmProps] where:
 * - targetId: the ID pending confirmation (or null)
 * - requestConfirm: call with an ID to open the dialog
 * - open/onOpenChange: pass to ConfirmDialog
 */
export function useConfirmDialog() {
  const [targetId, setTargetId] = useState<string | null>(null);

  const requestConfirm = useCallback((id: string) => {
    setTargetId(id);
  }, []);

  const open = targetId !== null;

  const onOpenChange = useCallback((v: boolean) => {
    if (!v) setTargetId(null);
  }, []);

  const reset = useCallback(() => setTargetId(null), []);

  return { targetId, requestConfirm, open, onOpenChange, reset };
}
