import { useState } from "react";
import {
  useCreateGlobalSkill,
  useCreateWorkspaceSkill,
  useCreateProjectSkill,
} from "@/lib/hooks";
import type { Skill } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- Create Skill Dialog ---

export function SkillDialog({
  open,
  onOpenChange,
  scope,
  workspaceId,
  projectId,
  editSkill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "workspace" | "project";
  workspaceId: string;
  projectId: string;
  editSkill?: Skill | null;
}) {
  const createGlobal = useCreateGlobalSkill();
  const createWorkspace = useCreateWorkspaceSkill(workspaceId);
  const createProject = useCreateProjectSkill(workspaceId, projectId);

  const [name, setName] = useState(editSkill?.name ?? "");
  const [content, setContent] = useState(editSkill?.content ?? "");
  const [error, setError] = useState("");

  const [prevEdit, setPrevEdit] = useState<Skill | null | undefined>(undefined);
  if (editSkill !== prevEdit) {
    setPrevEdit(editSkill);
    setName(editSkill?.name ?? "");
    setContent(editSkill?.content ?? "");
    setError("");
  }

  function reset() {
    setName("");
    setContent("");
    setError("");
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required");
      return;
    }
    setError("");
    try {
      const data = { name: name.trim(), content: content.trim() };
      if (scope === "global") await createGlobal.mutateAsync(data);
      else if (scope === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createGlobal.isPending || createWorkspace.isPending || createProject.isPending;
  const isEditing = !!editSkill;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Skill" : `Add Skill (${scope})`}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Edit the "${editSkill.name}" skill at ${scope} level.`
              : `Create a new SKILL.md at the ${scope} level.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              placeholder="e.g. api-design"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEditing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-content">Content (Markdown)</Label>
            <Textarea
              id="skill-content"
              placeholder={"# Skill Name\n\nDescription and instructions..."}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[200px] font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
