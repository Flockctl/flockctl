import { useState } from "react";
import { Plus } from "lucide-react";
import { useCreateTask } from "@/lib/hooks";
import type { TaskCreate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetStages,
  BottomSheetTitle,
  BottomSheetTrigger,
  type StagePill,
} from "@/components/design";

/**
 * Create Task From Project — bottom-sheet variant of the create-task
 * flow scoped to a known project. The project's git context (repoUrl +
 * baseBranch) is shown as badges in the header so the user can confirm
 * which checkout the task will run against.
 *
 * M27 refresh: surface migrated from a centered shadcn Dialog
 * (`sm:max-w-lg`) to the shared `BottomSheet` primitive — slides up
 * from the bottom edge of the viewport, with a stage-pills strip
 * (Agent → Settings → Review) and a 2-column body (form + Summary
 * sidebar). Field IDs preserved (`ctp-agent`, `ctp-prompt`,
 * `ctp-timeout`, `ctp-workdir`, `ctp-isolate`).
 */

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
  // Renamed from `setTimeout` to avoid shadowing the global `setTimeout()`
  // function — the destructured setter would otherwise be confused with the
  // built-in inside this component scope. ESLint doesn't catch the shadow
  // on destructured useState identifiers.
  const [timeoutSecs, setTimeoutSecs] = useState("300");
  const [workingDir, setWorkingDir] = useState("");
  // Worktree isolation opt-in. Mirrors `claude --worktree` — when on,
  // the executor materialises a per-task git worktree under
  // `<project>/.flockctl/worktrees/task-<id>/` so this task's edits
  // can't collide with a parallel one. Off by default to match the
  // legacy shared-cwd behaviour every existing user expects.
  const [isolateWorktree, setIsolateWorktree] = useState(false);
  const [formError, setFormError] = useState("");

  const createTask = useCreateTask();

  function resetForm() {
    setAgent("");
    setPrompt("");
    setTimeoutSecs("300");
    setWorkingDir("");
    setIsolateWorktree(false);
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
      timeout_seconds: Number(timeoutSecs) || 300,
    };
    data.agent = trimmedAgent;
    if (prompt.trim()) data.prompt = prompt.trim();
    if (workingDir.trim()) data.working_dir = workingDir.trim();
    if (isolateWorktree) data.isolation = "worktree";

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

  // Stage-pills derived from form state.
  const agentDone = agent.trim().length > 0;
  const promptDone = prompt.trim().length > 0;
  const allDone = agentDone;
  const stages: StagePill[] = [
    { label: "Agent", state: agentDone ? "done" : "active" },
    {
      label: "Settings",
      state: !agentDone ? "todo" : promptDone ? "done" : "active",
      hint: isolateWorktree ? "isolated" : undefined,
    },
    { label: "Review", state: allDone ? "active" : "todo" },
  ];

  return (
    <BottomSheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <BottomSheetTrigger asChild>
        <Button variant="outline" size="sm" data-testid="ctp-trigger">
          <Plus aria-hidden="true" />
          New task
        </Button>
      </BottomSheetTrigger>
      <BottomSheetContent className="p-0" data-testid="ctp-dialog">
        <BottomSheetHeader className="px-6 pt-2 pb-3">
          <BottomSheetTitle>Create Task</BottomSheetTitle>
          <BottomSheetDescription>
            Create a standalone execution task with this project's git context.
          </BottomSheetDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Git context:</span>
            {repoUrl ? (
              <Badge variant="secondary">{repoUrl}</Badge>
            ) : (
              <Badge variant="outline">no remote</Badge>
            )}
            <Badge variant="outline">{baseBranch}</Badge>
          </div>
        </BottomSheetHeader>

        <BottomSheetStages stages={stages} data-testid="ctp-stages" />

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
          data-testid="ctp-form"
        >
          <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_240px]">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
              <div className="space-y-3">
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
                      value={timeoutSecs}
                      onChange={(e) => setTimeoutSecs(e.target.value)}
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
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
                  <input
                    id="ctp-isolate"
                    type="checkbox"
                    className="mt-1"
                    checked={isolateWorktree}
                    onChange={(e) => setIsolateWorktree(e.target.checked)}
                  />
                  <Label htmlFor="ctp-isolate" className="cursor-pointer">
                    <div className="font-medium">
                      Run in isolated git worktree
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Creates a fresh branch (
                      <code>flockctl/task-&lt;id&gt;</code>) and worktree under{" "}
                      <code>.flockctl/worktrees/</code>. Lets parallel tasks
                      edit the same project without colliding. Requires the
                      project to be a git repo with at least one commit; falls
                      back silently otherwise.
                    </div>
                  </Label>
                </div>
                {formError && (
                  <p
                    className="text-sm text-destructive"
                    data-testid="ctp-error"
                  >
                    {formError}
                  </p>
                )}
              </div>
            </div>

            {/* Summary sidebar */}
            <aside
              className="hidden border-l border-zinc-200 bg-zinc-50/60 px-4 py-4 sm:flex sm:flex-col dark:border-zinc-800 dark:bg-zinc-900/40"
              aria-label="Summary"
            >
              <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                Summary
              </p>
              <dl className="mt-3 space-y-3 text-[11.5px]">
                <div>
                  <dt className="text-zinc-500">Agent</dt>
                  <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {agent.trim() || (
                      <span className="text-zinc-400 italic">required</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Branch</dt>
                  <dd className="mt-0.5 truncate font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {baseBranch}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Working dir</dt>
                  <dd className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-700 dark:text-zinc-300">
                    {workingDir.trim() || (
                      <span className="font-sans text-zinc-400 italic">
                        project root
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Timeout</dt>
                  <dd className="mt-0.5 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {Number(timeoutSecs) || 300}s
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Isolation</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {isolateWorktree ? "git worktree" : "shared cwd"}
                  </dd>
                </div>
              </dl>

              <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                  Side-effects
                </p>
                <ul className="mt-1.5 space-y-1 text-[10.5px] text-zinc-600 dark:text-zinc-400">
                  <li>
                    +1 row in <span className="font-mono">tasks</span>
                  </li>
                  {isolateWorktree && (
                    <li>
                      git worktree under{" "}
                      <span className="font-mono">.flockctl/worktrees/</span>
                    </li>
                  )}
                </ul>
              </div>
            </aside>
          </div>

          <BottomSheetFooter>
            <Button
              type="submit"
              disabled={createTask.isPending}
              data-testid="ctp-submit"
            >
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </BottomSheetFooter>
        </form>
      </BottomSheetContent>
    </BottomSheet>
  );
}
