/**
 * Entity-aware system prompt builder for plan-entity chats.
 *
 * Used by the unified chat-stream handler in `src/routes/chats.ts`. Chats carry
 * only a flat `(entity_type, entity_id)` pair on the chat row, so when a slice
 * or task chat arrives without its milestone/slice parent we walk
 * `.flockctl/plan/` to locate the file.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getPlanDir } from "./plan-store/index.js";

export type PlanEntityType = "milestone" | "slice" | "task";

export interface EntityRef {
  entityType: string | null | undefined;
  entityId: string | null | undefined;
  /** Parent milestone slug — optional for slice/task; resolved by walking when missing. */
  milestoneId?: string | null;
  /** Parent slice slug — optional for task; resolved by walking when missing. */
  sliceId?: string | null;
}

/**
 * Resolve the absolute path to the `.md` file backing a planning entity, or
 * `null` when the entity is unknown or not on disk yet. Walks the plan dir
 * when the caller did not supply the parent milestone/slice slugs.
 */
export function resolveEntityFilePath(
  projectPath: string,
  entity: EntityRef,
): string | null {
  if (!projectPath) return null;
  if (!entity.entityType || !entity.entityId) return null;
  const planDir = getPlanDir(projectPath);
  if (!existsSync(planDir)) return null;

  const entityType = entity.entityType as string;
  const entityId = entity.entityId;
  const milestoneId = entity.milestoneId ?? undefined;
  const sliceId = entity.sliceId ?? undefined;

  if (entityType === "milestone") {
    return join(planDir, entityId, "milestone.md");
  }

  if (entityType === "slice") {
    if (milestoneId) return join(planDir, milestoneId, entityId, "slice.md");
    // Walk milestones to find a matching slice subdir.
    for (const ms of readdirSync(planDir, { withFileTypes: true })) {
      if (!ms.isDirectory()) continue;
      const candidate = join(planDir, ms.name, entityId, "slice.md");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  if (entityType === "task") {
    if (milestoneId && sliceId) {
      return join(planDir, milestoneId, sliceId, `${entityId}.md`);
    }
    // Walk milestone × slice to find a matching task file.
    for (const ms of readdirSync(planDir, { withFileTypes: true })) {
      if (!ms.isDirectory()) continue;
      const msDir = join(planDir, ms.name);
      for (const sl of readdirSync(msDir, { withFileTypes: true })) {
        if (!sl.isDirectory()) continue;
        const candidate = join(msDir, sl.name, `${entityId}.md`);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  return null;
}

/**
 * Build an entity-aware system prompt string for a plan-entity chat.
 *
 * Returns `undefined` when the chat has no entity context — callers should
 * fall back to their default system prompt in that case. The returned string
 * is meant to be prepended to (or replace) the default; the handler decides.
 */
export function buildEntityAwareSystemPrompt(
  entity: EntityRef,
  projectPath: string,
  projectName?: string,
): string | undefined {
  if (!entity.entityType || !entity.entityId) return undefined;
  if (!projectPath) return undefined;

  const filePath = resolveEntityFilePath(projectPath, entity);
  let entityContent = "";
  if (filePath && existsSync(filePath)) {
    try {
      entityContent = readFileSync(filePath, "utf-8");
    } catch {
      // Entity file may be unreadable — fall through with empty content so the
      // rest of the prompt still carries the entity ids.
    }
  }

  const projectLabel = projectName ?? "this project";
  const parts = [
    `You are an AI assistant helping with project planning for "${projectLabel}".`,
    `You are discussing a ${entity.entityType}: "${entity.entityId}".`,
  ];
  if (entityContent) {
    parts.push(
      `\nCurrent ${entity.entityType} file content:\n\`\`\`markdown\n${entityContent}\n\`\`\``,
    );
  }
  parts.push(
    `\nHelp the user refine this ${entity.entityType}. You can discuss goals, structure, success criteria, and implementation details.`,
    `Keep responses focused and actionable. Use the project working directory: ${projectPath}`,
  );
  return parts.join("\n");
}

export interface WorkspaceProjectRef {
  name: string;
  path: string | null;
  description?: string | null;
}

/**
 * Build a workspace-aware system prompt that lists the projects belonging to
 * the workspace so the agent can reason across them. Returns `undefined` when
 * there is nothing useful to add (no workspace name/path).
 *
 * The returned text is deliberately directive: workspaces are named
 * collections of projects, and the agent should treat the listed project
 * paths as the authoritative scope. Without that nudge agents tend to `ls`
 * the workspace root, recurse into unrelated siblings, or grep across the
 * whole filesystem when a user's request clearly belongs to one project.
 *
 * Layered AGENTS.md guidance (user / workspace / project) is injected into
 * the agent system prompt by `AgentSession.injectAgentGuidance()` — not here.
 * This builder only assembles the workspace-scoping nudge.
 */
export function buildWorkspaceSystemPrompt(
  workspaceName: string,
  workspacePath: string,
  projects: WorkspaceProjectRef[],
): string | undefined {
  if (!workspaceName || !workspacePath) return undefined;

  const parts = [
    `You are an AI assistant helping with work inside the "${workspaceName}" workspace.`,
    `Workspace path: ${workspacePath}`,
  ];

  const withPath = projects.filter((p) => p.path);
  if (withPath.length > 0) {
    parts.push(
      "",
      `This workspace is a named collection of ${withPath.length} project(s). Each project is a self-contained directory — you MUST treat these project paths as the authoritative scope for any file operation:`,
      "",
    );
    for (const p of withPath) {
      const desc = p.description ? ` — ${p.description}` : "";
      parts.push(`- ${p.name} (${p.path})${desc}`);
    }
    parts.push(
      "",
      "Rules for operating across this workspace:",
      "1. Before reading, searching, or editing files, decide which project (from the list above) the user's request belongs to and operate inside that project's path.",
      "2. Do NOT run Grep/Glob/ListDir against the workspace root when the request clearly concerns one project — scope the search to that project's path instead.",
      "3. Only cross project boundaries when the user's request explicitly spans multiple projects.",
      "4. Files and directories inside the workspace root that do not belong to any listed project are NOT part of this workspace — ignore them unless the user points at them directly.",
    );
  } else {
    parts.push(
      "",
      "This workspace currently has no projects with known paths. Operate inside the workspace root, but ask the user to clarify which subdirectory owns the request before making broad changes.",
    );
  }

  return parts.join("\n");
}
