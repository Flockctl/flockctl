import { useState } from "react";
import { useCreateMilestone } from "@/lib/hooks";
import type { MilestoneCreate } from "@/lib/types";
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
  DialogTrigger,
} from "@/components/ui/dialog";

// --- Create Milestone Dialog (manual) ---

export function CreateMilestoneDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [vision, setVision] = useState("");
  const [orderIndex, setOrderIndex] = useState("0");
  const [formError, setFormError] = useState("");

  const createMilestone = useCreateMilestone(projectId);

  function resetForm() {
    setTitle("");
    setDescription("");
    setVision("");
    setOrderIndex("0");
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("Title is required.");
      return;
    }

    const data: MilestoneCreate = {
      title: trimmedTitle,
      order_index: parseInt(orderIndex, 10) || 0,
    };
    if (description.trim()) data.description = description.trim();
    if (vision.trim()) data.vision = vision.trim();

    try {
      await createMilestone.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create milestone",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Create Milestone</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Milestone</DialogTitle>
          <DialogDescription>
            Manually add a new milestone to this project.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cm-title">Title *</Label>
            <Input
              id="cm-title"
              placeholder="Milestone title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cm-desc">Description</Label>
            <Textarea
              id="cm-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cm-vision">Vision</Label>
            <Textarea
              id="cm-vision"
              value={vision}
              onChange={(e) => setVision(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cm-order">Order Index</Label>
            <Input
              id="cm-order"
              type="number"
              value={orderIndex}
              onChange={(e) => setOrderIndex(e.target.value)}
            />
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createMilestone.isPending}>
              {createMilestone.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// (Edit Milestone / Slice dialogs removed — editing via full-screen editor+chat modal)
