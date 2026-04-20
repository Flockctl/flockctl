import { useState, useCallback } from "react";
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
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isPending?: boolean;
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
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
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
