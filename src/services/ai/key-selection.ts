import { getDb } from "../../db/index.js";
import { aiProviderKeys, workspaces } from "../../db/schema.js";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { getProjectById } from "../../lib/db-helpers.js";
import { jsonSafeParseNumberArray } from "../../lib/json-safe-parse.js";

export interface KeySelection {
  id: number;
  provider: string;
  keyValue?: string | null;
  providerType: string;
  configDir?: string | null;
}

/**
 * Local thin wrapper around the canonical {@link jsonSafeParseNumberArray}
 * that returns `[]` for missing / malformed inputs (instead of `null`),
 * matching the prior contract every caller expects.
 */
function safeParseJsonArray(value: string | null | undefined): number[] {
  return jsonSafeParseNumberArray(value) ?? [];
}

/**
 * Seed a default Claude CLI key (~/.claude) if no keys exist.
 * Called once at startup after migrations.
 */
export function seedDefaultKey(): void {
  const db = getDb();
  const count = db.select({ count: sql<number>`count(*)` }).from(aiProviderKeys).get()?.count ?? 0;
  if (count > 0) return;

  db.insert(aiProviderKeys).values({
    provider: "claude_cli",
    providerType: "cli",
    label: "Default",
    cliCommand: "claude",
    configDir: null,       // null = ~/.claude (default)
    priority: 0,
    isActive: true,
  }).run();

  console.log("Seeded default Claude CLI key (~/.claude)");
}

/**
 * Resolve allowed key IDs with inheritance: task → project → workspace.
 * Project-level overrides workspace-level (no merge).
 *
 * Accepts either `projectId` (for tasks/chats scoped to a project) or
 * `workspaceId` (for workspace-only chats with no project context). When both
 * are absent the function returns an empty array, which callers treat as
 * "no restriction". Same when no whitelist is configured at any level.
 *
 * History: workspace-only chats used to bypass this entirely — passing
 * `projectId: null` short-circuited at the top of the function and the
 * workspace's own whitelist was never consulted, so a workspace-restricted
 * key set didn't apply to chats started directly on the workspace page.
 * Adding `workspaceId` here closes that gap.
 */
export function resolveAllowedKeyIds(task: {
  allowedKeyIds?: string | null;
  projectId?: number | null;
  workspaceId?: number | null;
}): number[] {
  // 1. Task-level override (highest priority)
  if (task.allowedKeyIds) {
    return safeParseJsonArray(task.allowedKeyIds);
  }

  const db = getDb();

  if (task.projectId) {
    const project = getProjectById(task.projectId);
    if (!project) {
      // Project lookup failed — fall through to the workspace-only branch
      // below if a workspaceId was supplied alongside, otherwise no
      // restriction. Matches the legacy behaviour of returning [] for
      // missing projects without a workspace fallback.
      if (!task.workspaceId) return [];
    } else {
      // 2. Project-level override
      if (project.allowedKeyIds) {
        return safeParseJsonArray(project.allowedKeyIds);
      }

      // 3. Workspace-level fallback (project's own workspaceId takes
      //    precedence over an explicit task.workspaceId — the project
      //    binding is the source of truth for plan-side resolution).
      if (project.workspaceId) {
        const ws = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
        if (ws?.allowedKeyIds) {
          return safeParseJsonArray(ws.allowedKeyIds);
        }
      }
      return [];
    }
  }

  // 4. Workspace-only fallback — covers chats started on the workspace page
  //    where there's no project context at all. Without this branch the
  //    workspace's `allowed_key_ids` whitelist would be silently ignored.
  if (task.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, task.workspaceId)).get();
    if (ws?.allowedKeyIds) {
      return safeParseJsonArray(ws.allowedKeyIds);
    }
  }

  return [];
}

export async function selectKeyForTask(task: {
  model?: string | null;
  projectId?: number | null;
  assignedKeyId?: number | null;
  failedKeyIds?: string | null;
  allowedKeyIds?: string | null;
}, options?: {
  excludeKeyIds?: number[];
}): Promise<KeySelection> {
  const db = getDb();
  const excludedIds = new Set(options?.excludeKeyIds ?? []);

  // If a specific key is assigned, use it
  if (task.assignedKeyId) {
    if (excludedIds.has(task.assignedKeyId)) {
      throw new Error("No available AI keys. Add a key via /keys endpoint.");
    }
    const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, task.assignedKeyId)).get();
    if (key) return { id: key.id, provider: key.provider, keyValue: key.keyValue, providerType: key.providerType, configDir: key.configDir };
  }

  // Parse failed key IDs
  const failedIds = safeParseJsonArray(task.failedKeyIds);

  // Resolve allowed keys: task → project → workspace
  const allowedIds = resolveAllowedKeyIds(task);

  // Get all active keys, sorted by priority
  let candidates = db
    .select()
    .from(aiProviderKeys)
    .where(
      and(
        eq(aiProviderKeys.isActive, true),
        or(isNull(aiProviderKeys.disabledUntil), sql`${aiProviderKeys.disabledUntil} < datetime('now')`)
      )
    )
    .orderBy(aiProviderKeys.priority)
    .all();

  // Filter out failed keys (Set.has = O(1); plain Array.includes was O(n*m)).
  if (failedIds.length > 0) {
    const failedSet = new Set(failedIds);
    candidates = candidates.filter(k => !failedSet.has(k.id));
  }

  // Filter to allowed keys if specified.
  if (allowedIds.length > 0) {
    const allowedSet = new Set(allowedIds);
    candidates = candidates.filter(k => allowedSet.has(k.id));
  }

  // Exclude key IDs reserved or unavailable for this scheduling attempt.
  if (excludedIds.size > 0) {
    candidates = candidates.filter(k => !excludedIds.has(k.id));
  }

  if (candidates.length === 0) {
    throw new Error("No available AI keys. Add a key via /keys endpoint.");
  }

  const key = candidates[0]!;
  return { id: key.id, provider: key.provider, keyValue: key.keyValue, providerType: key.providerType, configDir: key.configDir };
}
