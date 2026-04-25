import { useState } from "react";
import { useCreateTask } from "@/lib/hooks";
import type { TaskCreate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
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

// --- Create Task From Project Dialog ---

export function CreateTaskFromProjectDialog({
  projectId,
  repoUrl,
  baseBranch,
}: {
  projectId: string;
  repoUrl: string | null;
  baseBranch: string;
}) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [timeout, setTimeout] = useState("300");
  const [workingDir, setWorkingDir] = useState("");
  const [formError, setFormError] = useState("");

  const createTask = useCreateTask();

  function resetForm() {
    setAgent("");
    setPrompt("");
    setTimeout("300");
    setWorkingDir("");
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedAgent = agent.trim();

    if (!trimmedAgent) {
      setFormError("Agent is required.");
      return;
    }

    const data: TaskCreate = {
      project_id: projectId,
      timeout_seconds: Number(timeout) || 300,
    };
    data.agent = trimmedAgent;
    if (prompt.trim()) data.prompt = prompt.trim();
    if (workingDir.trim()) data.working_dir = workingDir.trim();

    try {
      await createTask.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create task",
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
          Create Task
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>
            Create a standalone execution task with this project's git context.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Git context:</span>
          <Badge variant="secondary">{repoUrl}</Badge>
          <Badge variant="outline">{baseBranch}</Badge>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ctp-agent">Agent</Label>
            <Input
              id="ctp-agent"
              required
              placeholder="e.g. claude"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ctp-prompt">Prompt</Label>
            <Textarea
              id="ctp-prompt"
              placeholder="Task prompt..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ctp-timeout">Timeout (seconds)</Label>
              <Input
                id="ctp-timeout"
                type="number"
                value={timeout}
                onChange={(e) => setTimeout(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ctp-workdir">Working directory</Label>
              <Input
                id="ctp-workdir"
                placeholder="optional"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
              />
            </div>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createTask.isPending}>
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
