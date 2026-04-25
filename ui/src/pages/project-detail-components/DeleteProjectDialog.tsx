import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDeleteProject } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

// --- Delete Project Dialog ---

export function DeleteProjectDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const deleteProject = useDeleteProject();

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
        title="Delete Project"
        description="This will permanently delete the project and all its milestones, slices, and tasks. This action cannot be undone."
        isPending={deleteProject.isPending}
        onConfirm={() => {
          deleteProject.mutate(projectId, {
            onSuccess: () => {
              setOpen(false);
              navigate("/projects");
            },
          });
        }}
      />
    </>
  );
}
