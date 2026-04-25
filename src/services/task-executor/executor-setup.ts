import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { projects, tasks, workspaces } from "../../db/schema.js";
import { getDefaultModel, getFlockctlHome } from "../../config/index.js";
import {
  resolvePermissionMode,
  allowedRoots as computeAllowedRoots,
} from "../permission-resolver.js";
import { buildCodebaseContext } from "../git-context.js";
import { resolveTaskPrompt } from "../prompt-resolver.js";
import { loadProjectConfig } from "../project-config.js";
import { loadWorkspaceConfig } from "../workspace-config.js";
import type { KeySelection } from "../ai/key-selection.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

export interface TaskRunContext {
  codebaseCtx: string;
  prompt: string;
  projectRecord: ProjectRow | undefined;
  workspaceRecord: WorkspaceRow | undefined;
  workingDir: string;
  gitCommitBefore: string | null;
  model: string;
  timeout: number | undefined;
  requiresApproval: boolean;
  permissionMode: ReturnType<typeof resolvePermissionMode>;
  allowedRoots: string[];
  workspaceContext: {
    name: string;
    path: string;
    projects: Array<{ name: string; path: string | null; description?: string | null }>;
  } | undefined;
  agentId: string | undefined;
}

/**
 * Prepare everything required to start an AgentSession for `task`:
 * codebase context, prompt, project/workspace config resolution,
 * working dir creation, git commit snapshot, permission mode, and the
 * sibling-projects context.
 *
 * Throws on prompt/codebase failures — callers should translate those
 * into TaskStatus.FAILED.
 */
export async function buildTaskRunContext(
  task: TaskRow,
  selectedKey: KeySelection | null,
): Promise<TaskRunContext> {
  const db = getDb();

  const codebaseCtx = task.projectId ? await buildCodebaseContext(task.projectId) : "";
  const prompt = resolveTaskPrompt(task);

  // Always fetch project so we can read permission_mode / workspace link
  let projectRecord: ProjectRow | undefined;
  if (task.projectId) {
    projectRecord = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
  }
  let workspaceRecord: WorkspaceRow | undefined;
  if (projectRecord?.workspaceId) {
    workspaceRecord = db.select().from(workspaces).where(eq(workspaces.id, projectRecord.workspaceId)).get();
  }

  // Resolution order: task override > project path > flockctl home
  let workingDir = task.workingDir ?? undefined;
  if (!workingDir && projectRecord?.path) workingDir = projectRecord.path;
  if (!workingDir) workingDir = getFlockctlHome();

  // Ensure workingDir exists — spawn will ENOENT on missing cwd
  if (!existsSync(workingDir)) {
    mkdirSync(workingDir, { recursive: true });
  }

  let gitCommitBefore: string | null = null;
  if (existsSync(join(workingDir, ".git"))) {
    try {
      gitCommitBefore = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workingDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      db.update(tasks)
        .set({ gitCommitBefore })
        .where(eq(tasks.id, task.id))
        .run();
    } catch {
      // Not a git repo — skip diff tracking
    }
  }

  // .flockctl/config.yaml is the single source of truth for project + workspace
  // settings (portable across machines via git). DB holds only machine-local state
  // (name, path, workspaceId, status counters).
  const projectConfig = projectRecord?.path ? loadProjectConfig(projectRecord.path) : {};
  const workspaceConfig = workspaceRecord?.path ? loadWorkspaceConfig(workspaceRecord.path) : {};

  // Resolution order: task > project config.yaml > global default
  const model = task.model ?? projectConfig.model ?? getDefaultModel();
  const timeout = task.timeoutSeconds ?? projectConfig.defaultTimeout ?? undefined;
  const requiresApproval = task.requiresApproval ?? projectConfig.requiresApproval ?? false;

  const permissionMode = resolvePermissionMode({
    task: task.permissionMode,
    project: projectConfig.permissionMode,
    workspace: workspaceConfig.permissionMode,
  });
  const allowedRoots = computeAllowedRoots({
    workspacePath: workspaceRecord?.path,
    projectPath: projectRecord?.path,
    workingDir,
  });

  // Workspace projects context — surface the full project list of the
  // task's parent workspace so the agent treats those project paths as
  // the authoritative scope rather than `ls`-ing the workspace root.
  // No-op when the task has no workspace (standalone project or ad-hoc).
  let workspaceContext: TaskRunContext["workspaceContext"];
  if (workspaceRecord?.path) {
    const siblingProjects = db
      .select({
        name: projects.name,
        path: projects.path,
        description: projects.description,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceRecord.id))
      .all();
    workspaceContext = {
      name: workspaceRecord.name,
      path: workspaceRecord.path,
      projects: siblingProjects,
    };
  }

  // Dispatch: the selected AI Provider Key's `provider` chooses the agent
  // backend. `github_copilot` keys route through `CopilotProvider`; every
  // other provider falls through to the registry default (`claude-code`).
  const agentId = selectedKey?.provider === "github_copilot" ? "copilot" : undefined;

  return {
    codebaseCtx,
    prompt,
    projectRecord,
    workspaceRecord,
    workingDir,
    gitCommitBefore,
    model,
    timeout,
    requiresApproval,
    permissionMode,
    allowedRoots,
    workspaceContext,
    agentId,
  };
}
