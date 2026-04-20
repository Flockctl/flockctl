import { useState } from "react";
import {
  useGlobalSecrets,
  useWorkspaceSecrets,
  useProjectSecrets,
  useUpsertGlobalSecret,
  useUpsertWorkspaceSecret,
  useUpsertProjectSecret,
  useDeleteGlobalSecret,
  useDeleteWorkspaceSecret,
  useDeleteProjectSecret,
} from "@/lib/hooks";
import type { SecretRecord, SecretScope } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyRound, Plus, Trash2, Pencil } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

export interface SecretsPanelProps {
  scope: SecretScope;
  workspaceId?: string;
  projectId?: string;
}

function useSecretsForScope(props: SecretsPanelProps) {
  const globalQ = useGlobalSecrets();
  const workspaceQ = useWorkspaceSecrets(props.workspaceId ?? "");
  const projectQ = useProjectSecrets(props.projectId ?? "");

  if (props.scope === "global") {
    return { items: globalQ.data?.secrets ?? [], isLoading: globalQ.isLoading };
  }
  if (props.scope === "workspace") {
    return { items: workspaceQ.data?.secrets ?? [], isLoading: workspaceQ.isLoading };
  }
  return { items: projectQ.data?.secrets ?? [], isLoading: projectQ.isLoading };
}

function SecretDialog({
  open,
  onOpenChange,
  props,
  editSecret,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  props: SecretsPanelProps;
  editSecret: SecretRecord | null;
}) {
  const upsertGlobal = useUpsertGlobalSecret();
  const upsertWorkspace = useUpsertWorkspaceSecret(props.workspaceId ?? "");
  const upsertProject = useUpsertProjectSecret(props.projectId ?? "");

  const [name, setName] = useState(editSecret?.name ?? "");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(editSecret?.description ?? "");
  const [error, setError] = useState("");

  const [prevEdit, setPrevEdit] = useState<SecretRecord | null>(editSecret);
  if (editSecret !== prevEdit) {
    setPrevEdit(editSecret);
    setName(editSecret?.name ?? "");
    setValue("");
    setDescription(editSecret?.description ?? "");
    setError("");
  }

  function reset() {
    setName("");
    setValue("");
    setDescription("");
    setError("");
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      setError("Name must be a valid identifier (letters, digits, underscore; can't start with digit)");
      return;
    }
    if (!editSecret && !value) {
      setError("Value is required");
      return;
    }
    try {
      const payload = {
        name: trimmed,
        value: value,
        description: description.trim() || null,
      };
      if (props.scope === "global") await upsertGlobal.mutateAsync(payload);
      else if (props.scope === "workspace") await upsertWorkspace.mutateAsync(payload);
      else await upsertProject.mutateAsync(payload);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = upsertGlobal.isPending || upsertWorkspace.isPending || upsertProject.isPending;
  const isEditing = !!editSecret;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Update Secret" : "Add Secret"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Rotate the value of "${editSecret.name}" at the ${props.scope} scope. The current value is never shown — entering a new one replaces it.`
              : `Store a secret at the ${props.scope} scope. Reference it from MCP env with $\{secret:NAME\}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              placeholder="e.g. GITHUB_TOKEN"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEditing}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-value">
              Value {isEditing && <span className="text-muted-foreground">(leave blank to keep current)</span>}
            </Label>
            <Input
              id="secret-value"
              type="password"
              autoComplete="off"
              placeholder="paste the secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-description">Description (optional)</Label>
            <Textarea
              id="secret-description"
              placeholder="What is this secret for? (e.g. github API token for the github MCP server)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[60px]"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : isEditing && !value ? "Update description" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SecretsPanel(props: SecretsPanelProps) {
  const { items, isLoading } = useSecretsForScope(props);

  const deleteGlobal = useDeleteGlobalSecret();
  const deleteWorkspace = useDeleteWorkspaceSecret(props.workspaceId ?? "");
  const deleteProject = useDeleteProjectSecret(props.projectId ?? "");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSecret, setEditSecret] = useState<SecretRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SecretRecord | null>(null);
  const deleteConfirm = useConfirmDialog();

  function handleCreate() {
    setEditSecret(null);
    setDialogOpen(true);
  }

  function handleEdit(secret: SecretRecord) {
    setEditSecret(secret);
    setDialogOpen(true);
  }

  function handleDelete(secret: SecretRecord) {
    setDeleteTarget(secret);
    deleteConfirm.requestConfirm(secret.name);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut =
      props.scope === "global" ? deleteGlobal :
      props.scope === "workspace" ? deleteWorkspace : deleteProject;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  const deletePending =
    deleteGlobal.isPending || deleteWorkspace.isPending || deleteProject.isPending;

  const scopeHint =
    props.scope === "global"
      ? "Available to every workspace and project unless shadowed by a more specific scope."
      : props.scope === "workspace"
        ? "Available to this workspace and its projects. Shadows global secrets with the same name."
        : "Available only to this project. Shadows workspace and global secrets with the same name.";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Secrets</CardTitle>
          </div>
          <Button size="sm" variant="outline" onClick={handleCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add Secret
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Encrypted at rest. Reference from MCP env values as <code className="rounded bg-muted px-1">{"${secret:NAME}"}</code>. {scopeHint}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No secrets at this scope yet.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {items.map((secret) => (
              <div key={secret.id} className="flex items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium font-mono flex-1">{secret.name}</span>
                {secret.description && (
                  <span className="text-xs text-muted-foreground truncate max-w-[45%]">
                    {secret.description}
                  </span>
                )}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {"${secret:" + secret.name + "}"}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Update value or description"
                  onClick={() => handleEdit(secret)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleDelete(secret)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <SecretDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        props={props}
        editSecret={editSecret}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Secret"
        description={`Delete secret "${deleteTarget?.name}"? MCP configs referencing it will show an unresolved placeholder until you remove the reference or recreate the secret.`}
        isPending={deletePending}
        onConfirm={doDelete}
      />
    </Card>
  );
}
