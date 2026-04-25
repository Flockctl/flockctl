import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDeleteWorkspace } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

// --- Delete Workspace Dialog ---

export function _DeleteWorkspaceDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const deleteWorkspace = useDeleteWorkspace();

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete Workspace"
        description="This will permanently delete the workspace and remove all project associations. This action cannot be undone."
        isPending={deleteWorkspace.isPending}
        onConfirm={() => {
          deleteWorkspace.mutate(workspaceId, {
            onSuccess: () => {
              setOpen(false);
              navigate("/workspaces");
            },
          });
        }}
      />
    </>
  );
}
