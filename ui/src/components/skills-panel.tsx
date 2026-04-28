import { useState, useMemo } from "react";
import {
  useGlobalSkills,
  useWorkspaceSkills,
  useProjectSkills,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Wand2, Plus, Trash2, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { DisableToggle } from "@/components/skills-mcp/DisableToggle";
import { SkillDialog } from "@/components/skills-mcp/SkillDialog";
import { levelColors } from "@/components/skills-mcp/shared";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

// SkillDialog lives in @/components/skills-mcp/SkillDialog (shared with the
// full-page Skills tab). It supports global scope too — the panel never
// invokes that, but the tab does.

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
    // In the project view a skill is effectively disabled if EITHER the
    // workspace OR the project itself disables it. Workspace disables
    // cascade to all child projects (see resolveSkillsForProject) so the
    // UI must mirror that — otherwise the skill looks "enabled" here while
    // the daemon has already filtered it out of the project's effective set.
    return wsDisabledSet.has(key) || projDisabledSet.has(key);
  }

  // True only when the disable comes from the workspace (so the user can't
  // toggle it off from the project view — it must be re-enabled at the
  // workspace level).
  function isDisabledByWorkspace(skill: Skill): boolean {
    if (level !== "project") return false;
    return wsDisabledSet.has(`${skill.level}:${skill.name}`);
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
                const inheritedDisable = isDisabledByWorkspace(skill);
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
                        <Badge variant="outline" className="text-xs">
                          {inheritedDisable ? "disabled by workspace" : "disabled"}
                        </Badge>
                      )}
                      <DisableToggle
                        disabled={disabled}
                        title={
                          inheritedDisable
                            ? "Disabled at workspace level — re-enable in workspace settings"
                            : disabled
                              ? `Enable at ${level}`
                              : `Disable at ${level}`
                        }
                        pending={isPending || inheritedDisable}
                        onToggle={() => toggleDisable(skill)}
                      />
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
                    <DisableToggle
                      disabled={disabled}
                      title={disabled ? "Enable skill" : "Disable skill"}
                      pending={toggleDisabledPending}
                      onToggle={() => toggleDisable(skill)}
                    />
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
        scope={level}
        workspaceId={workspaceId}
        projectId={projectId ?? ""}
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
