import { useState, useMemo } from "react";
import {
  useGlobalSkills,
  useWorkspaceSkills,
  useProjectSkills,
  useCreateWorkspaceSkill,
  useCreateProjectSkill,
  useDeleteWorkspaceSkill,
  useDeleteProjectSkill,
  useWorkspaceDisabledSkills,
  useToggleWorkspaceDisabledSkill,
  useProjectDisabledSkills,
  useToggleProjectDisabledSkill,
} from "@/lib/hooks";
import type { Skill } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
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
import { Wand2, Plus, Trash2, Pencil, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

const levelColors: Record<string, string> = {
  global: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  workspace: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  project: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
};

// --- Skill Dialog (create + edit) ---

function SkillDialog({
  open,
  onOpenChange,
  level,
  workspaceId,
  projectId,
  editSkill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
  editSkill?: Skill | null;
}) {
  const createWorkspace = useCreateWorkspaceSkill(workspaceId);
  const createProject = useCreateProjectSkill(workspaceId, projectId ?? "");

  const [name, setName] = useState(editSkill?.name ?? "");
  const [content, setContent] = useState(editSkill?.content ?? "");
  const [error, setError] = useState("");

  // Sync when editSkill changes (dialog opens with different skill)
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
      if (level === "workspace") await createWorkspace.mutateAsync(data);
      else await createProject.mutateAsync(data);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isPending = createWorkspace.isPending || createProject.isPending;
  const isEditing = !!editSkill;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Skill" : "Add Skill"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Edit the "${editSkill.name}" skill at ${level} level.`
              : `Create a new SKILL.md at the ${level} level.`}
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

// --- SkillsPanel ---

export function SkillsPanel({
  level,
  workspaceId,
  projectId,
}: {
  level: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
}) {
  const globalQ = useGlobalSkills();
  const wsQ = useWorkspaceSkills(workspaceId);
  const projQ = useProjectSkills(workspaceId, projectId ?? "");

  const skills = level === "project" ? (projQ.data ?? []) : (wsQ.data ?? []);
  const isLoading = level === "project" ? projQ.isLoading : wsQ.isLoading;

  const deleteWs = useDeleteWorkspaceSkill(workspaceId);
  const deleteProj = useDeleteProjectSkill(workspaceId, projectId ?? "");

  const wsDisabledQ = useWorkspaceDisabledSkills(workspaceId);
  const projDisabledQ = useProjectDisabledSkills(projectId ?? "");
  const toggleWsDisabled = useToggleWorkspaceDisabledSkill(workspaceId);
  const toggleProjDisabled = useToggleProjectDisabledSkill(projectId ?? "");

  const wsDisabledSet = useMemo(
    () => new Set((wsDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [wsDisabledQ.data],
  );
  const projDisabledSet = useMemo(
    () => new Set((projDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [projDisabledQ.data],
  );

  const inherited = useMemo<Skill[]>(() => {
    const items: Skill[] = [];
    if (globalQ.data) items.push(...globalQ.data);
    if (level === "project" && wsQ.data) items.push(...wsQ.data);
    return items;
  }, [globalQ.data, wsQ.data, level]);

  const deleteConfirm = useConfirmDialog();
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  function isSkillDisabled(skill: Skill): boolean {
    const key = `${skill.level}:${skill.name}`;
    if (level === "workspace") return wsDisabledSet.has(key);
    return projDisabledSet.has(key);
  }

  function toggleDisable(skill: Skill) {
    const disabled = isSkillDisabled(skill);
    if (level === "workspace") {
      toggleWsDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabled });
    } else {
      toggleProjDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabled });
    }
  }

  const toggleDisabledPending =
    level === "workspace" ? toggleWsDisabled.isPending : toggleProjDisabled.isPending;

  function handleDelete(skill: Skill) {
    setDeleteTarget(skill);
    deleteConfirm.requestConfirm(skill.name);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut = level === "workspace" ? deleteWs : deleteProj;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  function handleCreate() {
    setEditSkill(null);
    setDialogOpen(true);
  }

  function handleEdit(skill: Skill) {
    setEditSkill(skill);
    setDialogOpen(true);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Skills</CardTitle>
          </div>
          <Button size="sm" variant="outline" onClick={handleCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add Skill
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          SKILL.md files at the {level} level. Skills define specialized instructions for AI agents.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {inherited.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Inherited ({level === "workspace" ? "global" : "global + workspace"})
            </p>
            <div className="divide-y rounded-md border">
              {inherited.map((skill) => {
                const key = `${skill.level}:${skill.name}`;
                const isExpanded = expandedSkill === key;
                const disabled = isSkillDisabled(skill);
                const isPending = toggleDisabledPending;
                return (
                  <div key={key}>
                    <div
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 ${disabled ? "opacity-50" : ""}`}
                      onClick={() => setExpandedSkill(isExpanded ? null : key)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className={`text-sm font-medium flex-1 ${disabled ? "line-through" : ""}`}>
                        {skill.name}
                      </span>
                      <Badge variant="secondary" className={`text-xs ${levelColors[skill.level]}`}>
                        {skill.level}
                      </Badge>
                      {disabled && (
                        <Badge variant="outline" className="text-xs">disabled</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title={disabled ? `Enable at ${level}` : `Disable at ${level}`}
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleDisable(skill);
                        }}
                      >
                        {disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    {isExpanded && (
                      <div className="px-3 pb-3">
                        <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-60 overflow-auto rounded bg-muted p-2">
                          {skill.content}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : skills.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No skills configured at this level.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {skills.map((skill) => {
              const isExpanded = expandedSkill === skill.name;
              const disabled = isSkillDisabled(skill);
              return (
                <div key={skill.name}>
                  <div
                    className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 ${disabled ? "opacity-50" : ""}`}
                    onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className={`text-sm font-medium flex-1 ${disabled ? "line-through" : ""}`}>
                      {skill.name}
                    </span>
                    <Badge variant="secondary" className={`text-xs ${levelColors[skill.level]}`}>
                      {skill.level}
                    </Badge>
                    {disabled && (
                      <Badge variant="outline" className="text-xs">disabled</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title={disabled ? "Enable skill" : "Disable skill"}
                      disabled={toggleDisabledPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDisable(skill);
                      }}
                    >
                      {disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Edit skill"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(skill);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Delete skill"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(skill);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3">
                      <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-60 overflow-auto rounded bg-muted p-2">
                        {skill.content}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <SkillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        level={level}
        workspaceId={workspaceId}
        projectId={projectId}
        editSkill={editSkill}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Skill"
        description={`Delete skill "${deleteTarget?.name}"? This cannot be undone.`}
        isPending={deleteWs.isPending || deleteProj.isPending}
        onConfirm={doDelete}
      />
    </Card>
  );
}
