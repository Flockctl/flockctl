import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useWorkspace,
  useUpdateWorkspace,
  useDeleteWorkspace,
  useAddProjectToWorkspace,
  useRemoveProjectFromWorkspace,
  useProjects,
  useWorkspaceDashboard,
  useWorkspaceDependencyGraph,
  useChatStream,
  useCreateChat,
  useAIKeys,
} from "@/lib/hooks";
import type { ToolExecution, WorkspaceMilestoneNode } from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { StatCard } from "@/components/stat-card";
import { Target, Layers, Play, CheckCircle, Send, Square, X, Loader2, Check, AlertCircle, MessageSquare, GitBranch, ArrowRight, DollarSign, Hash, XCircle, RotateCcw, Settings } from "lucide-react";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// StatCard imported from @/components/stat-card

// --- Status badge helper ---

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
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

    try {
      await updateWorkspace.mutateAsync({
        id: workspaceId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          allowed_key_ids: allowedKeyIds.length > 0 ? allowedKeyIds : null,
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
            <Label>Allowed AI Keys</Label>
            <p className="text-xs text-muted-foreground">
              Restrict tasks to selected keys. None selected means all keys are allowed.
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
            </div>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={updateWorkspace.isPending}>
              {updateWorkspace.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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

// --- Add Project Dialog ---

function AddProjectDialog({ workspaceId, existingProjectIds }: { workspaceId: string; existingProjectIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [formError, setFormError] = useState("");

  const { data: allProjects } = useProjects();
  const addProject = useAddProjectToWorkspace();

  const availableProjects = (allProjects ?? []).filter(
    (p) => !existingProjectIds.includes(p.id),
  );

  function resetForm() {
    setSelectedProjectId("");
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!selectedProjectId) {
      setFormError("Select a project to add.");
      return;
    }

    try {
      await addProject.mutateAsync({
        workspaceId,
        projectId: selectedProjectId,
      });
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to add project",
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
        <Button size="sm">Add Project</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            Add a project to this workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="add-project-select">Project</Label>
            <Select
              value={selectedProjectId}
              onValueChange={setSelectedProjectId}
            >
              <SelectTrigger id="add-project-select">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {availableProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={addProject.isPending}>
              {addProject.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Tool execution label helper ---

function toolLabel(name: string, status: ToolExecution["status"], input: Record<string, unknown>) {
  const verb = status === "pending"
    ? { list_projects: "Listing projects", get_project_plan: "Getting project plan", get_milestone_detail: "Getting milestone", get_slice_detail: "Getting slice", search_tasks: "Searching tasks", create_task: "Creating task", update_task: "Updating task" }[name] ?? `Running ${name}`
    : { list_projects: "Listed projects", get_project_plan: "Got project plan", get_milestone_detail: "Got milestone", get_slice_detail: "Got slice", search_tasks: "Searched tasks", create_task: "Created task", update_task: "Updated task" }[name] ?? `Ran ${name}`;
  const title = (input as Record<string, unknown>).title as string | undefined;
  return title ? `${verb}: ${title}` : verb;
}

// --- Workspace Chat Panel ---

function WorkspaceChatPanel({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const { startStream, cancelStream, isStreaming, streamedContent, error, toolExecutions, clearChat } = useChatStream();
  const createChatMutation = useCreateChat();
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; toolExecutions?: ToolExecution[] }[]>([]);
  const [inputValue, setInputValue] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);

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

    // Ensure chat exists
    let activeChatId = chatId;
    if (!activeChatId) {
      const newChat = await createChatMutation.mutateAsync({
        workspaceId: parseInt(workspaceId),
        title: `Workspace: ${workspaceName}`,
      });
      activeChatId = String(newChat.id);
      setChatId(activeChatId);
    }

    await startStream(activeChatId, { content });
  }, [inputValue, isStreaming, startStream, workspaceId, workspaceName, chatId, createChatMutation]);

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
        <MessageSquare className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">AI Chat — {workspaceName}</span>
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
                {te.status === "success" && <Check className="h-3 w-3 text-green-600 dark:text-green-400" />}
                {te.status === "error" && <AlertCircle className="h-3 w-3 text-red-600 dark:text-red-400" />}
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
                {te.status === "success" && <Check className="h-3 w-3 text-green-600 dark:text-green-400" />}
                {te.status === "error" && <AlertCircle className="h-3 w-3 text-red-600 dark:text-red-400" />}
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
        {!isStreaming && !error && messages.length > 0 && messages[messages.length - 1].role === "user" && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Response was not received</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1 h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => setInputValue(messages[messages.length - 1].content)}
            >
              <RotateCcw className="h-3 w-3" /> Retry
            </Button>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="flex items-end gap-2 border-t p-3">
        <Textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your workspace projects..."
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

// --- Dependency Graph Card (workspace dependency-graph visualization) ---

function milestoneNodeBadge(status: string) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
          completed
        </Badge>
      );
    case "active":
      return <Badge>active</Badge>;
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function DependencyGraphCard({
  graph,
}: {
  graph: { nodes: WorkspaceMilestoneNode[]; waves: string[][]; errors: string[] };
}) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.milestone_id, n]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Dependency Graph
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {graph.waves.map((waveIds, waveIdx) => (
          <div key={waveIdx}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Wave {waveIdx + 1}
            </p>
            <div className="flex flex-wrap gap-3">
              {waveIds.map((mid) => {
                const node = nodeMap.get(mid);
                if (!node) return null;
                const deps = node.depends_on
                  .map((did) => nodeMap.get(did))
                  .filter(Boolean);
                return (
                  <div
                    key={mid}
                    className="min-w-[200px] rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{node.title}</span>
                      {milestoneNodeBadge(node.status)}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {node.project_name}
                    </p>
                    {deps.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <ArrowRight className="h-3 w-3" />
                        depends on:{" "}
                        {deps.map((d, i) => (
                          <span key={d!.milestone_id}>
                            {i > 0 && ", "}
                            {d!.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {graph.errors.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="mb-1 text-xs font-medium text-destructive">
              Graph Errors
            </p>
            {graph.errors.map((err, i) => (
              <p key={i} className="text-xs text-destructive">
                {err}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main Page ---

export default function WorkspaceDetailPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const [chatOpen, setChatOpen] = useState(false);
  const {
    data: workspace,
    isLoading,
    error,
  } = useWorkspace(workspaceId ?? "");
  const removeProject = useRemoveProjectFromWorkspace();
  const removeConfirm = useConfirmDialog();
  const { data: dashboard, isLoading: dashboardLoading } = useWorkspaceDashboard(workspaceId ?? "");
  const { data: depGraph } = useWorkspaceDependencyGraph(workspaceId ?? "");

  if (!workspaceId) {
    return <p className="text-destructive">Missing workspace ID.</p>;
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-destructive">
        Failed to load workspace: {error.message}
      </p>
    );
  }

  if (!workspace) return null;

  return (
    <div className="flex gap-6">
    <div className={`space-y-6 ${chatOpen ? "flex-1 min-w-0" : "w-full"}`}>
      {/* Workspace info header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => navigate("/workspaces")}
            >
              &larr; Workspaces
            </Button>
          </div>
          <h1 className="mt-2 text-2xl font-bold">{workspace.name}</h1>
          {workspace.description && (
            <p className="mt-1 text-muted-foreground">
              {workspace.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatTime(workspace.created_at)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setChatOpen(!chatOpen)}>
            <MessageSquare className="mr-1.5 h-4 w-4" />
            AI Chat
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/workspaces/${workspaceId}/settings`)}
          >
            <Settings className="mr-1 h-4 w-4" />
            Settings
          </Button>
        </div>
      </div>

      <Separator />

      {/* Projects */}
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardAction>
            <AddProjectDialog
              workspaceId={workspaceId}
              existingProjectIds={workspace.projects.map((p) => p.id)}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          {workspace.projects.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No projects in this workspace.
            </p>
          )}
          {workspace.projects.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell
                      className="cursor-pointer font-medium"
                      onClick={() => navigate(`/projects/${project.id}`)}
                    >
                      {project.name}
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground">
                      {project.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={removeProject.isPending}
                        onClick={() => removeConfirm.requestConfirm(project.id)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>

        <ConfirmDialog
          open={removeConfirm.open}
          onOpenChange={removeConfirm.onOpenChange}
          title="Remove Project"
          description="Remove this project from the workspace? The project itself will not be deleted."
          confirmLabel="Remove"
          isPending={removeProject.isPending}
          onConfirm={() => {
            if (removeConfirm.targetId) {
              removeProject.mutate(
                { workspaceId, projectId: removeConfirm.targetId },
                { onSuccess: () => removeConfirm.reset() },
              );
            }
          }}
        />
      </Card>

      {/* Dashboard */}
      {workspace.projects.length > 0 && (
        <>
          {/* Row 1: Existing metrics */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Target}
              label="Total Milestones"
              value={dashboard?.total_milestones ?? 0}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={Layers}
              label="Active Slices"
              value={dashboard?.active_slices ?? 0}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={Play}
              label="Running Tasks"
              value={dashboard?.running_tasks ?? 0}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={CheckCircle}
              label="Completed Slices"
              value={dashboard?.completed_slices ?? 0}
              isLoading={dashboardLoading}
            />
          </div>

          {/* Row 2: Cost + Task metrics */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={DollarSign}
              label="Workspace Spend"
              value={`$${(dashboard?.total_cost_usd ?? 0).toFixed(2)}`}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={Hash}
              label="Total Tokens"
              value={formatTokensShort((dashboard?.total_input_tokens ?? 0) + (dashboard?.total_output_tokens ?? 0))}
              subtitle={`in: ${formatTokensShort(dashboard?.total_input_tokens ?? 0)} / out: ${formatTokensShort(dashboard?.total_output_tokens ?? 0)}`}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={CheckCircle}
              label="Completed Tasks"
              value={dashboard?.completed_tasks ?? 0}
              isLoading={dashboardLoading}
            />
            <StatCard
              icon={XCircle}
              label="Failed Tasks"
              value={dashboard?.failed_tasks ?? 0}
              isLoading={dashboardLoading}
            />
          </div>

          {/* Charts: Cost by Project + Task Status */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {(dashboard?.cost_by_project ?? []).length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Cost by Project</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={(dashboard?.cost_by_project ?? []).map((p) => ({ name: p.project_name, cost: p.cost_usd }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: "var(--foreground)" }} />
                      <YAxis tick={{ fontSize: 12, fill: "var(--foreground)" }} />
                      <Tooltip formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} contentStyle={{ backgroundColor: "var(--popover)", borderColor: "var(--border)", color: "var(--popover-foreground)" }} />
                      <Bar dataKey="cost" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {dashboard && (dashboard.active_tasks > 0 || dashboard.completed_tasks > 0 || dashboard.failed_tasks > 0) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Task Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie
                        data={[
                          ...(dashboard.active_tasks > 0 ? [{ name: "Active", value: dashboard.active_tasks, fill: "#3b82f6" }] : []),
                          ...(dashboard.completed_tasks > 0 ? [{ name: "Completed", value: dashboard.completed_tasks, fill: "#22c55e" }] : []),
                          ...(dashboard.failed_tasks > 0 ? [{ name: "Failed", value: dashboard.failed_tasks, fill: "#ef4444" }] : []),
                        ]}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={({ name, value }) => `${name}: ${value}`}
                      >
                        {[
                          ...(dashboard.active_tasks > 0 ? [{ fill: "#3b82f6" }] : []),
                          ...(dashboard.completed_tasks > 0 ? [{ fill: "#22c55e" }] : []),
                          ...(dashboard.failed_tasks > 0 ? [{ fill: "#ef4444" }] : []),
                        ].map((entry, index) => (
                          <Cell key={index} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "var(--popover)", borderColor: "var(--border)", color: "var(--popover-foreground)" }} />
                      <Legend wrapperStyle={{ color: "var(--foreground)" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </div>

          {dashboard && dashboard.project_summaries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Project Overview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {dashboard.project_summaries.map((ps) => (
                  <details key={ps.project_id} className="group">
                    <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      {ps.project_name}
                      <span className="text-xs text-muted-foreground">
                        ({ps.milestone_count} milestones)
                      </span>
                    </summary>
                    <div className="mt-2 ml-4 space-y-2">
                      {ps.tree.milestones.map((m) => (
                        <div key={m.id} className="rounded border p-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{m.title}</span>
                            {statusBadge(m.status)}
                            <span className="text-xs text-muted-foreground">
                              {(m.slices ?? []).length} slices
                            </span>
                          </div>
                        </div>
                      ))}
                      {ps.tree.milestones.length === 0 && (
                        <p className="text-xs text-muted-foreground">No milestones</p>
                      )}
                    </div>
                  </details>
                ))}
              </CardContent>
            </Card>
          )}

          {depGraph && depGraph.nodes.length > 0 && depGraph.waves.length > 0 && (
            <DependencyGraphCard graph={depGraph} />
          )}
        </>
      )}
    </div>

    {/* Chat side panel */}
    {chatOpen && (
      <div className="w-[400px] shrink-0 h-[calc(100vh-8rem)] sticky top-4">
        <WorkspaceChatPanel
          workspaceId={workspaceId}
          workspaceName={workspace.name}
          onClose={() => setChatOpen(false)}
        />
      </div>
    )}
    </div>
  );
}
