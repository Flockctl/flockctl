import { useState } from "react";
import { useUpdateWorkspace, useAIKeys } from "@/lib/hooks";
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
import { Checkbox } from "@/components/ui/checkbox";

// --- Edit Workspace Dialog ---

export function _EditWorkspaceDialog({
  workspaceId,
  currentName,
  currentDescription,
  currentAllowedKeyIds,
}: {
  workspaceId: string;
  currentName: string;
  currentDescription: string | null;
  currentAllowedKeyIds: number[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription ?? "");
  const [allowedKeyIds, setAllowedKeyIds] = useState<number[]>(currentAllowedKeyIds ?? []);
  const [formError, setFormError] = useState("");

  const updateWorkspace = useUpdateWorkspace();
  const { data: aiKeys } = useAIKeys();
  const keys = (aiKeys ?? []).filter(k => k.is_active);

  function resetForm() {
    setName(currentName);
    setDescription(currentDescription ?? "");
    setAllowedKeyIds(currentAllowedKeyIds ?? []);
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }

    // Mirror the POST /workspaces rule: at least one active key must remain
    // in the allow-list. Clearing is now rejected by the server with 422.
    if (allowedKeyIds.length === 0) {
      setFormError("Pick at least one AI provider key.");
      return;
    }

    try {
      await updateWorkspace.mutateAsync({
        id: workspaceId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          allowed_key_ids: allowedKeyIds,
        },
      });
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to update workspace",
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
        <Button variant="outline" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Workspace</DialogTitle>
          <DialogDescription>
            Update workspace name or description.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-ws-name">Name *</Label>
            <Input
              id="edit-ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-ws-desc">Description</Label>
            <Textarea
              id="edit-ws-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label>Allowed AI Keys *</Label>
            <p className="text-xs text-muted-foreground">
              Pick at least one active key. Access is opt-in — clearing the
              list is not permitted (the workspace would be unusable).
            </p>
            <div className="flex flex-wrap gap-3">
              {keys.map((k) => (
                <label
                  key={k.id}
                  className="flex items-center gap-1.5 text-sm"
                >
                  <Checkbox
                    checked={allowedKeyIds.includes(Number(k.id))}
                    onCheckedChange={(checked) => {
                      setAllowedKeyIds((prev) =>
                        checked
                          ? [...prev, Number(k.id)]
                          : prev.filter((id) => id !== Number(k.id)),
                      );
                    }}
                  />
                  {k.name ?? k.label ?? `Key #${k.id}`}
                </label>
              ))}
              {keys.length === 0 && (
                <p className="text-xs text-destructive">
                  No active AI keys configured. Add one in Settings → AI Keys.
                </p>
              )}
            </div>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                updateWorkspace.isPending ||
                allowedKeyIds.length === 0 ||
                keys.length === 0
              }
            >
              {updateWorkspace.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
