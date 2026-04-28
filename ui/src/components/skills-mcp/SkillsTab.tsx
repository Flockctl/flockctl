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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { DisableToggle } from "./DisableToggle";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { levelColors } from "./shared";
import { SkillContent } from "./SkillContent";
import { SkillDialog } from "./SkillDialog";

// --- Skills Tab ---

export function SkillsTab({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const globalQ = useGlobalSkills();
  const wsQ = useWorkspaceSkills(workspaceId);
  const projQ = useProjectSkills(workspaceId, projectId);

  const deleteWs = useDeleteWorkspaceSkill(workspaceId);
  const deleteProj = useDeleteProjectSkill(workspaceId, projectId);

  const wsDisabledQ = useWorkspaceDisabledSkills(workspaceId);
  const projDisabledQ = useProjectDisabledSkills(projectId);
  const toggleWsDisabled = useToggleWorkspaceDisabledSkill(workspaceId);
  const toggleProjDisabled = useToggleProjectDisabledSkill(projectId);

  const wsDisabledSet = useMemo(
    () => new Set((wsDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [wsDisabledQ.data],
  );
  const projDisabledSet = useMemo(
    () => new Set((projDisabledQ.data?.disabled_skills ?? []).map((e) => `${e.level}:${e.name}`)),
    [projDisabledQ.data],
  );

  const deleteConfirm = useConfirmDialog();
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogScope, setDialogScope] = useState<"global" | "workspace" | "project">("global");
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  const allSkills = useMemo(() => {
    const items: Skill[] = [];
    if (globalQ.data) items.push(...globalQ.data);
    if (wsQ.data) items.push(...wsQ.data);
    if (projQ.data) items.push(...projQ.data);
    return items;
  }, [globalQ.data, wsQ.data, projQ.data]);

  const isLoading = globalQ.isLoading;

  function handleDelete(skill: Skill) {
    setDeleteTarget(skill);
    deleteConfirm.requestConfirm(`${skill.level}:${skill.name}`);
  }

  function doDelete() {
    if (!deleteTarget) return;
    const mut = deleteTarget.level === "workspace" ? deleteWs : deleteProj;
    mut.mutate(deleteTarget.name, {
      onSuccess: () => {
        deleteConfirm.reset();
        setDeleteTarget(null);
      },
    });
  }

  function openCreate(scope: "global" | "workspace" | "project") {
    setEditSkill(null);
    setDialogScope(scope);
    setDialogOpen(true);
  }

  function openEdit(skill: Skill) {
    setEditSkill(skill);
    setDialogScope(skill.level as "global" | "workspace" | "project");
    setDialogOpen(true);
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openCreate("global")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Global
        </Button>
        {workspaceId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("workspace")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Workspace
          </Button>
        )}
        {projectId && (
          <Button size="sm" variant="outline" onClick={() => openCreate("project")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Project
          </Button>
        )}
      </div>

      {allSkills.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No skills configured. Add a skill at any level to get started.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Level</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {allSkills.map((skill) => {
              const key = `${skill.level}:${skill.name}`;
              const isExpanded = expandedSkill === key;
              const canToggleWs = !!workspaceId && skill.level === "global";
              const canToggleProj = !!projectId && (skill.level === "global" || skill.level === "workspace");
              const disabledByWs = canToggleWs && wsDisabledSet.has(`${skill.level}:${skill.name}`);
              const disabledByProj = canToggleProj && projDisabledSet.has(`${skill.level}:${skill.name}`);
              const isDisabled = disabledByWs || disabledByProj;
              return (
                <>
                  <TableRow
                    key={key}
                    className={`cursor-pointer ${isDisabled ? "opacity-50" : ""}`}
                    onClick={() => setExpandedSkill(isExpanded ? null : key)}
                  >
                    <TableCell className="w-8">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className={`font-medium ${isDisabled ? "line-through" : ""}`}>
                      {skill.name}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary" className={levelColors[skill.level]}>
                          {skill.level}
                        </Badge>
                        {disabledByWs && (
                          <Badge variant="outline" className="text-xs">disabled by workspace</Badge>
                        )}
                        {disabledByProj && (
                          <Badge variant="outline" className="text-xs">disabled by project</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canToggleWs && (
                          <DisableToggle
                            disabled={disabledByWs}
                            title={disabledByWs ? "Enable at workspace" : "Disable at workspace"}
                            pending={toggleWsDisabled.isPending}
                            onToggle={() =>
                              toggleWsDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabledByWs })
                            }
                          />
                        )}
                        {canToggleProj && (
                          <DisableToggle
                            disabled={disabledByProj}
                            title={disabledByProj ? "Enable at project" : "Disable at project"}
                            pending={toggleProjDisabled.isPending}
                            iconClassName="text-purple-600"
                            onToggle={() =>
                              toggleProjDisabled.mutate({ name: skill.name, level: skill.level, disable: !disabledByProj })
                            }
                          />
                        )}
                        {skill.level !== "global" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEdit(skill);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {skill.level !== "global" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(skill);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow key={`${key}-content`}>
                      <TableCell colSpan={4} className="p-3">
                        <SkillContent content={skill.content} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}

      <SkillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scope={dialogScope}
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
    </div>
  );
}
