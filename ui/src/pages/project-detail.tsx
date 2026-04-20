import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  useProject,
  useProjectConfig,
  useDeleteProject,
  useProjectTree,
  useCreateMilestone,
  useCreateSlice,
  useCreatePlanTask,
  useCreateTask,
  useAutoExecStatus,
  useStartAutoExecute,
  useStopAutoExecute,
  useActivateSlice,
  useCreateChat,
  useProjectSchedules,
  useTemplates,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
  useGeneratePlan,
  useGeneratePlanStatus,
  useUsageSummary,
  useUsageBreakdown,
  useProjectStats,
  useDeleteMilestone,
  useDeleteSlice,
  useDeletePlanTask,
  usePlanChatStream,
  usePlanFile,
  useUpdatePlanFile,
  useStartAutoExecuteAll,
} from "@/lib/hooks";
import type {
  MilestoneCreate,
  PlanSliceCreate,
  PlanTaskCreate,
  TaskCreate,
  MilestoneTree,
  PlanSliceTree,
  PlanTask,
  Schedule,
  ToolExecution,
} from "@/lib/types";
import { ScheduleStatus, ScheduleType } from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

import { StatCard } from "@/components/stat-card";
import { MessageSquare, Sparkles, Loader2, DollarSign, X, Check, AlertCircle, Send, Square, Hash, Target, Layers, Play, CheckCircle, XCircle, Clock, Trash2, FileText, Save, Zap, Settings } from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { CreateScheduleDialog } from "@/pages/schedules";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";

// --- Status badge helper ---

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600">
          completed
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
      return <Badge variant="outline">skipped</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

// --- Helper functions ---

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// --- Scheduled Tasks Section ---

function ScheduleStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    [ScheduleStatus.active]:
      "bg-green-500/15 text-green-700 dark:text-green-400",
    [ScheduleStatus.paused]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function formatScheduleTime(iso: string | null): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString();
}

function ProjectSchedulesSection({ projectId }: { projectId: string }) {
  const { data, isLoading } = useProjectSchedules(projectId, 0, 50, {
    refetchInterval: 10_000,
  });
  const { data: templatesData } = useTemplates(0, 100, projectId);
  const pauseSchedule = usePauseSchedule();
  const resumeSchedule = useResumeSchedule();
  const deleteSchedule = useDeleteSchedule();
  const deleteConfirm = useConfirmDialog();

  const templateMap = new Map<string, string>();
  if (templatesData?.items) {
    for (const tpl of templatesData.items) {
      templateMap.set(tpl.id, tpl.name);
    }
  }

  const schedules: Schedule[] = data?.items ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Scheduled Tasks</h2>
        <CreateScheduleDialog projectId={projectId} buttonSize="sm" />
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {!isLoading && schedules.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No scheduled tasks for this project.
        </p>
      )}

      {!isLoading && schedules.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next Fire</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((sched) => (
              <TableRow key={sched.id}>
                <TableCell className="font-medium">
                  {templateMap.get(sched.template_id) ??
                    String(sched.template_id).slice(0, 8)}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{sched.schedule_type}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {sched.schedule_type === ScheduleType.cron
                    ? sched.cron_expression ?? "\u2014"
                    : formatScheduleTime(sched.run_at)}
                </TableCell>
                <TableCell>
                  <ScheduleStatusBadge status={sched.status} />
                </TableCell>
                <TableCell className="text-xs">
                  {formatScheduleTime(sched.next_fire_time)}
                </TableCell>
                <TableCell>
                  <div
                    className="flex gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sched.status === ScheduleStatus.active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={pauseSchedule.isPending}
                        onClick={() => pauseSchedule.mutate(sched.id)}
                      >
                        Pause
                      </Button>
                    )}
                    {sched.status === ScheduleStatus.paused && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={resumeSchedule.isPending}
                        onClick={() => resumeSchedule.mutate(sched.id)}
                      >
                        Resume
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={deleteSchedule.isPending}
                      onClick={() => deleteConfirm.requestConfirm(sched.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Schedule"
        description="This will permanently delete this schedule. This action cannot be undone."
        isPending={deleteSchedule.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteSchedule.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}

// --- Delete Project Dialog ---

function DeleteProjectDialog({ projectId }: { projectId: string }) {
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

// --- Create Task From Project Dialog ---

function CreateTaskFromProjectDialog({
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
          <div className="grid grid-cols-2 gap-4">
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

// --- Generate Plan Dialog ---

function GeneratePlanDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"quick" | "deep">("quick");
  const [formError, setFormError] = useState("");
  const navigate = useNavigate();

  const generatePlan = useGeneratePlan(projectId);

  function resetForm() {
    setPrompt("");
    setMode("quick");
    setFormError("");
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmed = prompt.trim();
    if (!trimmed) {
      setFormError("Describe what you want to build.");
      return;
    }

    try {
      const res = await generatePlan.mutateAsync({
        prompt: trimmed,
        mode,
      });
      setOpen(false);
      navigate(`/tasks/${res.task_id}`);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to generate plan",
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
        <Button size="sm">
          <Sparkles className="mr-1 h-4 w-4" />
          Generate Plan
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate Plan with AI</DialogTitle>
          <DialogDescription>
            Describe your project goals and AI will create milestones, slices,
            and tasks automatically.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleGenerate} className="space-y-5 pt-2">
          <div className="space-y-2">
            <Label htmlFor="gp-prompt" className="text-sm font-medium">
              What do you want to build? *
            </Label>
            <Textarea
              id="gp-prompt"
              placeholder="Describe your project, features, technical requirements..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="resize-y"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gp-mode" className="text-sm font-medium">
              Planning Mode
            </Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "quick" | "deep")}>
              <SelectTrigger id="gp-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">Quick — concise plan</SelectItem>
                <SelectItem value="deep">Deep — thorough with risk, deps, verification</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={generatePlan.isPending}>
              {generatePlan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-4 w-4" />
                  Generate
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Create Milestone Dialog (manual) ---

function CreateMilestoneDialog({ projectId }: { projectId: string }) {
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

// --- Create Slice Dialog ---

function CreateSliceDialog({
  projectId,
  milestoneId,
}: {
  projectId: string;
  milestoneId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [risk, setRisk] = useState("medium");
  const [goal, setGoal] = useState("");
  const [demo, setDemo] = useState("");
  const [orderIndex, setOrderIndex] = useState("0");
  const [formError, setFormError] = useState("");

  const createSlice = useCreateSlice(projectId);

  function resetForm() {
    setTitle("");
    setDescription("");
    setRisk("medium");
    setGoal("");
    setDemo("");
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

    const data: PlanSliceCreate = {
      title: trimmedTitle,
      risk,
      order_index: parseInt(orderIndex, 10) || 0,
    };
    if (description.trim()) data.description = description.trim();
    if (goal.trim()) data.goal = goal.trim();
    if (demo.trim()) data.demo = demo.trim();

    try {
      await createSlice.mutateAsync({ milestoneId, data });
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create slice",
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
        <Button size="sm" variant="outline">
          Add Slice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Slice</DialogTitle>
          <DialogDescription>Add a new slice to this milestone.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cs-title">Title *</Label>
            <Input
              id="cs-title"
              placeholder="Slice title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cs-desc">Description</Label>
            <Textarea
              id="cs-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cs-risk">Risk</Label>
            <Select value={risk} onValueChange={setRisk}>
              <SelectTrigger id="cs-risk">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cs-goal">Goal</Label>
            <Input
              id="cs-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cs-demo">Demo</Label>
            <Input
              id="cs-demo"
              value={demo}
              onChange={(e) => setDemo(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cs-order">Order Index</Label>
            <Input
              id="cs-order"
              type="number"
              value={orderIndex}
              onChange={(e) => setOrderIndex(e.target.value)}
            />
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createSlice.isPending}>
              {createSlice.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Create PlanTask Dialog ---

function CreatePlanTaskDialog({
  projectId,
  milestoneId,
  sliceId,
}: {
  projectId: string;
  milestoneId: string;
  sliceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [estimate, setEstimate] = useState("");
  const [verify, setVerify] = useState("");
  const [orderIndex, setOrderIndex] = useState("0");
  const [formError, setFormError] = useState("");

  const createPlanTask = useCreatePlanTask(projectId);

  function resetForm() {
    setTitle("");
    setDescription("");
    setModel("");
    setEstimate("");
    setVerify("");
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

    const data: PlanTaskCreate = {
      title: trimmedTitle,
      order_index: parseInt(orderIndex, 10) || 0,
    };
    if (description.trim()) data.description = description.trim();
    if (model.trim()) data.model = model.trim();
    if (estimate.trim()) data.estimate = estimate.trim();
    if (verify.trim()) data.verify = verify.trim();

    try {
      await createPlanTask.mutateAsync({ milestoneId, sliceId, data });
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
        <Button size="sm" variant="outline">
          Add Task
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>Add a new task to this slice.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ct-title">Title *</Label>
            <Input
              id="ct-title"
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct-desc">Description</Label>
            <Textarea
              id="ct-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct-model">Model</Label>
            <Input
              id="ct-model"
              placeholder="e.g. claude-opus-4-7"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct-estimate">Estimate</Label>
            <Input
              id="ct-estimate"
              placeholder="e.g. 2h"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct-verify">Verify</Label>
            <Input
              id="ct-verify"
              placeholder="Verification command"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct-order">Order Index</Label>
            <Input
              id="ct-order"
              type="number"
              value={orderIndex}
              onChange={(e) => setOrderIndex(e.target.value)}
            />
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createPlanTask.isPending}>
              {createPlanTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Auto-Execution Controls ---

function AutoExecControls({
  projectId,
  milestone,
}: {
  projectId: string;
  milestone: MilestoneTree;
}) {
  const [isActive, setIsActive] = useState(false);
  const { data: execStatus } = useAutoExecStatus(projectId, milestone.id, {
    refetchInterval: isActive ? 5_000 : 30_000,
  });
  const { data: planGenStatus } = useGeneratePlanStatus(projectId);
  const planGenerating = !!planGenStatus?.generating;

  // Track active state for polling speed
  if ((execStatus?.status === "active") !== isActive) {
    setIsActive(execStatus?.status === "active");
  }

  const startAutoExec = useStartAutoExecute(projectId);
  const stopAutoExec = useStopAutoExecute(projectId);

  return (
    <div className="flex items-center gap-3">
      {isActive && execStatus ? (
        <>
          <span className="text-sm text-muted-foreground">
            {execStatus.completed_slices}/{execStatus.total_slices} slices
          </span>
          {execStatus.current_slice_ids.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {execStatus.current_slice_ids.length} slice{execStatus.current_slice_ids.length > 1 ? "s" : ""} active
            </Badge>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={stopAutoExec.isPending}
            onClick={() => stopAutoExec.mutate(milestone.id)}
          >
            {stopAutoExec.isPending ? "Stopping..." : "Stop"}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={startAutoExec.isPending || planGenerating}
          title={planGenerating ? "Plan is still being generated" : undefined}
          onClick={() =>
            startAutoExec.mutate({ milestoneId: milestone.id })
          }
        >
          {startAutoExec.isPending ? "Starting..." : "Auto-Execute"}
        </Button>
      )}
    </div>
  );
}

// --- Task Row ---

function TaskRow({
  task,
  projectId,
  milestoneId,
  sliceId,
  onOpenChat,
}: {
  task: PlanTask;
  projectId: string;
  milestoneId: string;
  sliceId: string;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const deleteTask = useDeletePlanTask(projectId);
  return (
    <div className="flex items-center gap-2 py-1.5 pl-12">
      <span className="text-sm">{task.title}</span>
      {statusBadge(task.status)}
      {task.verification_passed === true && (
        <span className="text-green-600 text-xs" title="Verification passed">
          &#10003;
        </span>
      )}
      {task.verification_passed === false && (
        <span className="text-red-600 text-xs" title="Verification failed">
          &#10007;
        </span>
      )}
      {task.task_id && (
        <Link
          to={`/tasks/${task.task_id}`}
          className="text-xs text-blue-600 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          View Logs
        </Link>
      )}
      <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {onOpenChat && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onOpenChat("task", task.id, milestoneId, sliceId, task.title)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (window.confirm(`Delete task "${task.title}"?`)) {
              deleteTask.mutate({ milestoneId, sliceId, taskId: task.id });
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// --- Slice Row ---

function SliceRow({
  projectId,
  milestoneId,
  slice,
  expanded,
  onToggle,
  autoExecActive,
  onOpenChat,
}: {
  projectId: string;
  milestoneId: string;
  slice: PlanSliceTree;
  expanded: boolean;
  onToggle: () => void;
  autoExecActive: boolean;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const activateSlice = useActivateSlice(projectId);
  const deleteSlice = useDeleteSlice(projectId);

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 pl-6 cursor-pointer hover:bg-muted/50 rounded"
        onClick={onToggle}
      >
        <span className="text-xs w-4">
          {(slice.tasks ?? []).length > 0 ? (expanded ? "\u25BE" : "\u25B8") : " "}
        </span>
        <span className="text-sm font-medium">{slice.title}</span>
        {statusBadge(slice.status)}
        <Badge variant="outline" className="text-xs">
          {slice.risk}
        </Badge>
        {slice.status === "pending" && !autoExecActive && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={activateSlice.isPending}
            onClick={(e) => {
              e.stopPropagation();
              activateSlice.mutate({ milestoneId, sliceId: slice.id });
            }}
          >
            Activate
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {onOpenChat && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => onOpenChat("slice", slice.id, milestoneId, undefined, slice.title)}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </Button>
          )}
          <CreatePlanTaskDialog
            projectId={projectId}
            milestoneId={milestoneId}
            sliceId={slice.id}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete slice "${slice.title}" and all its tasks?`)) {
                deleteSlice.mutate({ milestoneId, sliceId: slice.id });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {expanded &&
        (slice.tasks ?? []).map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projectId={projectId}
            milestoneId={milestoneId}
            sliceId={slice.id}
            onOpenChat={onOpenChat}
          />
        ))}
    </div>
  );
}

// --- Milestone Card ---

function MilestoneCard({
  projectId,
  milestone,
  expanded,
  onToggle,
  expandedSlices,
  onToggleSlice,
  onOpenChat,
}: {
  projectId: string;
  milestone: MilestoneTree;
  expanded: boolean;
  onToggle: () => void;
  expandedSlices: Set<string>;
  onToggleSlice: (id: string) => void;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const { data: execStatus } = useAutoExecStatus(projectId, milestone.id, {
    refetchInterval: 30_000,
  });
  const autoExecActive = execStatus?.status === "active";
  const deleteMilestone = useDeleteMilestone(projectId);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 flex-1">
          <span className="text-sm w-4">
            {expanded ? "\u25BE" : "\u25B8"}
          </span>
          <CardTitle className="text-base">{milestone.title}</CardTitle>
          {statusBadge(milestone.status)}
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenChat && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onOpenChat("milestone", milestone.id, undefined, undefined, milestone.title)}
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          )}
          <Link to={`/projects/${projectId}/execution/${milestone.id}`}>
            <Button size="sm" variant="outline">
              Dashboard
            </Button>
          </Link>
          <AutoExecControls projectId={projectId} milestone={milestone} />
          <CreateSliceDialog
            projectId={projectId}
            milestoneId={milestone.id}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete milestone "${milestone.title}" and all its slices/tasks?`)) {
                deleteMilestone.mutate(milestone.id);
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0">
          {milestone.slices.length === 0 && (
            <p className="text-sm text-muted-foreground pl-6">
              No slices yet.
            </p>
          )}
          {milestone.slices.map((slice) => (
            <SliceRow
              key={slice.id}
              projectId={projectId}
              milestoneId={milestone.id}
              slice={slice}
              expanded={expandedSlices.has(slice.id)}
              onToggle={() => onToggleSlice(slice.id)}
              autoExecActive={autoExecActive}
              onOpenChat={onOpenChat}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

// --- Chat context type ---

interface ChatContext {
  entity_type: "milestone" | "slice" | "task";
  entity_id: string;
  milestone_id?: string;
  slice_id?: string;
  title: string;
}

// --- Tool execution label helper ---

function toolLabel(name: string, status: ToolExecution["status"], input: Record<string, unknown>) {
  const verb = status === "pending"
    ? { create_task: "Creating task", update_task: "Updating task", delete_task: "Deleting task", create_slice: "Creating slice", update_slice: "Updating slice", update_milestone: "Updating milestone" }[name] ?? `Running ${name}`
    : { create_task: "Created task", update_task: "Updated task", delete_task: "Deleted task", create_slice: "Created slice", update_slice: "Updated slice", update_milestone: "Updated milestone" }[name] ?? `Ran ${name}`;
  const title = (input as Record<string, unknown>).title as string | undefined;
  return title ? `${verb}: ${title}` : verb;
}

// --- Plan Chat Panel ---

// --- Plan File Editor ---

function PlanFileEditor({
  projectId,
  context,
}: {
  projectId: string;
  context: ChatContext;
}) {
  const fileParams = {
    type: context.entity_type,
    milestone: context.entity_type === "milestone" ? context.entity_id
      : context.milestone_id,
    slice: context.entity_type === "slice" ? context.entity_id
      : context.slice_id,
    task: context.entity_type === "task" ? context.entity_id : undefined,
  };

  const { data: fileData, isLoading, error } = usePlanFile(projectId, fileParams);
  const updateFile = useUpdatePlanFile(projectId);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");

  const isDark = useMemo(() => {
    if (typeof window === "undefined") return false;
    return document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  }, []);

  const handleSave = useCallback(async () => {
    await updateFile.mutateAsync({ ...fileParams, content: contentRef.current });
    setDirty(false);
  }, [fileParams, updateFile]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // Create editor once when container is ready
  useEffect(() => {
    if (!editorRef.current) return;

    const extensions = [
      basicSetup,
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          contentRef.current = update.state.doc.toString();
          setDirty(true);
        }
      }),
      keymap.of([{
        key: "Mod-s",
        run: () => { handleSaveRef.current(); return true; },
      }]),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        },
        ".cm-content": {
          padding: "12px 0",
        },
        ".cm-gutters": {
          borderRight: "1px solid var(--border, #e5e7eb)",
          backgroundColor: "transparent",
        },
      }),
    ];

    if (isDark) {
      extensions.push(oneDark);
    }

    const state = EditorState.create({
      doc: fileData?.content ?? "",
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    contentRef.current = fileData?.content ?? "";

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark, fileData?.content]);

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load file</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">
          {fileData?.path?.split("/").slice(-3).join("/") ?? ""}
        </span>
        {dirty && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            disabled={updateFile.isPending}
            onClick={handleSave}
          >
            {updateFile.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </Button>
        )}
      </div>
      <div ref={editorRef} className="flex-1 overflow-hidden" />
    </div>
  );
}

function PlanChatPanel({
  projectId,
  context,
  onClose,
}: {
  projectId: string;
  context: ChatContext;
  onClose: () => void;
}) {
  const { startStream, cancelStream, isStreaming, streamedContent, error, toolExecutions, clearChat } = usePlanChatStream();
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; toolExecutions?: ToolExecution[] }[]>([]);
  const [inputValue, setInputValue] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);

  // Reset conversation when context entity changes
  useEffect(() => {
    setMessages([]);
    setInputValue("");
    clearChat();
  }, [context.entity_type, context.entity_id, clearChat]);

  // Auto-scroll tracking
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Scroll to bottom on new content
  const scrollTrigger = messages.length + streamedContent.length + toolExecutions.length;
  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [scrollTrigger]);

  // When streaming finishes, archive the assistant message
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && (streamedContent || toolExecutions.length > 0)) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: streamedContent, toolExecutions: [...toolExecutions] },
      ]);
      clearChat();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, streamedContent, toolExecutions, clearChat]);

  const handleSend = useCallback(async () => {
    const content = inputValue.trim();
    if (!content || isStreaming) return;
    setMessages((prev) => [...prev, { role: "user", content }]);
    setInputValue("");
    await startStream(projectId, {
      content,
      entity_context: {
        entity_type: context.entity_type,
        entity_id: context.entity_id,
        milestone_id: context.milestone_id,
        slice_id: context.slice_id,
      },
    });
  }, [inputValue, isStreaming, startStream, projectId, context]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Card className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b p-3">
        <Badge variant="outline" className="text-xs capitalize">{context.entity_type}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{context.title}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i}>
            <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[90%] whitespace-pre-wrap rounded-lg p-2.5 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {msg.content || "\u00A0"}
              </div>
            </div>
            {msg.toolExecutions?.map((te) => (
              <div key={te.id} className="flex items-center gap-1.5 py-1 pl-1 text-xs text-muted-foreground">
                {te.status === "pending" && <Loader2 className="h-3 w-3 animate-spin" />}
                {te.status === "success" && <Check className="h-3 w-3 text-green-600" />}
                {te.status === "error" && <AlertCircle className="h-3 w-3 text-red-600" />}
                <span>{te.status === "error" ? te.error ?? toolLabel(te.name, te.status, te.input) : toolLabel(te.name, te.status, te.input)}</span>
              </div>
            ))}
          </div>
        ))}

        {/* Live streaming content */}
        {isStreaming && (
          <>
            <div className="flex justify-start">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-muted p-2.5 text-sm">
                {streamedContent || "\u00A0"}
                <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-foreground" />
              </div>
            </div>
            {toolExecutions.map((te) => (
              <div key={te.id} className="flex items-center gap-1.5 py-1 pl-1 text-xs text-muted-foreground">
                {te.status === "pending" && <Loader2 className="h-3 w-3 animate-spin" />}
                {te.status === "success" && <Check className="h-3 w-3 text-green-600" />}
                {te.status === "error" && <AlertCircle className="h-3 w-3 text-red-600" />}
                <span>{te.status === "error" ? te.error ?? toolLabel(te.name, te.status, te.input) : toolLabel(te.name, te.status, te.input)}</span>
              </div>
            ))}
          </>
        )}

        {error && (
          <div className="rounded-lg bg-destructive/10 p-2.5 text-sm text-destructive">
            Error: {error}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="flex items-end gap-2 border-t p-3">
        <Textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Ask about this ${context.entity_type}...`}
          rows={1}
          className="max-h-24 min-h-[2.25rem] resize-none text-sm"
        />
        {isStreaming ? (
          <Button variant="destructive" size="icon" className="h-8 w-8 shrink-0" onClick={cancelStream}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button size="icon" className="h-8 w-8 shrink-0" disabled={!inputValue.trim()} onClick={handleSend}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </Card>
  );
}

// --- Main Page ---

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const createChat = useCreateChat();

  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
  } = useProject(projectId ?? "");

  const { data: projectConfig } = useProjectConfig(projectId ?? "");
  const baseBranch = projectConfig?.baseBranch ?? "main";

  const { data: planGenStatus } = useGeneratePlanStatus(projectId ?? "", {
    enabled: !!projectId,
  });
  const planGenerating = !!planGenStatus?.generating;

  const { data: tree, isLoading: treeLoading } = useProjectTree(
    projectId ?? "",
    { refetchInterval: planGenerating ? 3_000 : 30_000 },
  );

  const { data: projectUsage } = useUsageSummary(
    { project_id: projectId ?? "" },
    { enabled: !!projectId },
  );

  const { data: projectStats, isLoading: statsLoading } = useProjectStats(
    projectId ?? "",
    { enabled: !!projectId },
  );

  const { data: usageByDay } = useUsageBreakdown(
    { group_by: "day", project_id: projectId ?? "", period: "30d" },
    { enabled: !!projectId },
  );

  const autoExecAll = useStartAutoExecuteAll(projectId ?? "");

  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(
    new Set(),
  );
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(
    new Set(),
  );
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);

  function openChat(
    entity_type: ChatContext["entity_type"],
    entity_id: string,
    milestone_id: string | undefined,
    slice_id: string | undefined,
    title: string,
  ) {
    setChatContext({ entity_type, entity_id, milestone_id, slice_id, title });
  }

  function toggleMilestone(id: string) {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSlice(id: string) {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!projectId) {
    return <p className="text-destructive">Missing project ID.</p>;
  }

  if (projectLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (projectError) {
    return (
      <p className="text-destructive">
        Failed to load project: {projectError.message}
      </p>
    );
  }

  if (!project) {
    return <p className="text-muted-foreground">Project not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Project header */}
      <div className="flex items-start justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => navigate("/projects")}
          >
            &larr; Projects
          </Button>
          <h1 className="mt-2 text-2xl font-bold">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-muted-foreground">
              {project.description}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="secondary">{project.repo_url}</Badge>
            <Badge variant="outline">{baseBranch}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <CreateTaskFromProjectDialog
            projectId={projectId}
            repoUrl={project.repo_url}
            baseBranch={baseBranch}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={createChat.isPending}
            onClick={() =>
              createChat
                .mutateAsync({ project_id: project.id })
                .then((chat) => navigate(`/chats/${chat.id}`))
            }
          >
            <MessageSquare className="mr-1 h-4 w-4" />
            {createChat.isPending ? "Creating…" : "Chat"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/projects/${projectId}/settings`)}
          >
            <Settings className="mr-1 h-4 w-4" />
            Settings
          </Button>
          <DeleteProjectDialog projectId={projectId} />
        </div>
      </div>

      {/* Project Stats Row 1 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Project Spend"
          value={`$${(projectUsage?.total_cost_usd ?? 0).toFixed(2)}`}
          isLoading={!projectUsage}
        />
        <StatCard
          icon={Hash}
          label="Total Tokens"
          value={fmtTokens((projectUsage?.total_input_tokens ?? 0) + (projectUsage?.total_output_tokens ?? 0))}
          subtitle={`in: ${fmtTokens(projectUsage?.total_input_tokens ?? 0)} / out: ${fmtTokens(projectUsage?.total_output_tokens ?? 0)}`}
          isLoading={!projectUsage}
        />
        <StatCard
          icon={Target}
          label="Milestones"
          value={projectStats ? `${projectStats.milestones.in_progress} active / ${projectStats.milestones.total} total` : "0"}
          isLoading={statsLoading}
        />
        <StatCard
          icon={Layers}
          label="Slices"
          value={projectStats ? `${projectStats.slices.active} active / ${projectStats.slices.total} total` : "0"}
          isLoading={statsLoading}
        />
      </div>

      {/* Project Stats Row 2 */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Play}
          label="Running Tasks"
          value={projectStats?.tasks.running ?? 0}
          isLoading={statsLoading}
        />
        <StatCard
          icon={CheckCircle}
          label="Completed Tasks"
          value={(projectStats?.tasks.completed ?? 0) + (projectStats?.tasks.done ?? 0)}
          isLoading={statsLoading}
        />
        <StatCard
          icon={XCircle}
          label="Failed Tasks"
          value={projectStats?.tasks.failed ?? 0}
          isLoading={statsLoading}
        />
        <StatCard
          icon={Clock}
          label="Avg Duration"
          value={projectStats?.avg_task_duration_seconds != null ? fmtDuration(projectStats.avg_task_duration_seconds) : "N/A"}
          isLoading={statsLoading}
        />
      </div>

      {/* Charts: Usage Over Time + Token Breakdown */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Usage Over Time (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            {(usageByDay?.items ?? []).length === 0 ? (
              <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">No usage data</div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={(usageByDay?.items ?? []).map((item) => ({ date: item.scope_id ?? "", cost: item.cost_usd }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
                  <Line type="monotone" dataKey="cost" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Token Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {!projectUsage ? (
              <Skeleton className="h-[250px] w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={[
                  { name: "Input", tokens: projectUsage.total_input_tokens },
                  { name: "Output", tokens: projectUsage.total_output_tokens },
                  { name: "Cache Create", tokens: projectUsage.total_cache_creation_tokens ?? 0 },
                  { name: "Cache Read", tokens: projectUsage.total_cache_read_tokens ?? 0 },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value) => [Number(value).toLocaleString(), "Tokens"]} />
                  <Bar dataKey="tokens" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Planning tree + editor+chat modal */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Planning Tree</h2>
          <div className="flex items-center gap-2">
            {tree && tree.milestones.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={autoExecAll.isPending || planGenerating}
                title={planGenerating ? "Plan is still being generated" : undefined}
                onClick={() => {
                  if (window.confirm("Start auto-execution for all milestones?")) {
                    autoExecAll.mutate();
                  }
                }}
              >
                {autoExecAll.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                Auto-Execute All
              </Button>
            )}
            <GeneratePlanDialog projectId={projectId} />
            <CreateMilestoneDialog projectId={projectId} />
          </div>
        </div>

        {planGenerating && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Plan is being generated
              {planGenStatus?.mode ? ` (${planGenStatus.mode} mode)` : ""}
              &hellip; milestones and slices will appear as the agent writes them. Launching is disabled until generation finishes.
            </span>
          </div>
        )}

        {treeLoading && !tree && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {tree && tree.milestones.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No milestones yet. Use &quot;Generate Plan&quot; to create them automatically from a description.
          </p>
        )}

        {tree && tree.milestones.length > 0 && (
          <div className="space-y-3">
            {tree.milestones.map((milestone) => (
              <MilestoneCard
                key={milestone.id}
                projectId={projectId}
                milestone={milestone}
                expanded={expandedMilestones.has(milestone.id)}
                onToggle={() => toggleMilestone(milestone.id)}
                expandedSlices={expandedSlices}
                onToggleSlice={toggleSlice}
                onOpenChat={openChat}
              />
            ))}
          </div>
        )}
      </div>

      {/* Full-screen editor + chat modal */}
      <Dialog open={!!chatContext} onOpenChange={(v) => { if (!v) setChatContext(null); }}>
        <DialogContent
          showCloseButton={false}
          className="!grid-cols-1 sm:!max-w-[95vw] !max-w-[95vw] !w-[95vw] !h-[90vh] !p-0 !gap-0 !flex !flex-col"
        >
          <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs capitalize">{chatContext?.entity_type}</Badge>
              <span className="text-base font-semibold">{chatContext?.title}</span>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setChatContext(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Left: file editor */}
            <div className="flex-1 min-w-0 border-r h-full">
              {chatContext && (
                <PlanFileEditor
                  projectId={projectId}
                  context={chatContext}
                />
              )}
            </div>
            {/* Right: chat */}
            <div className="w-[400px] shrink-0 h-full">
              {chatContext && (
                <PlanChatPanel
                  projectId={projectId}
                  context={chatContext}
                  onClose={() => setChatContext(null)}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Separator />

      <ProjectSchedulesSection projectId={projectId} />
    </div>
  );
}
