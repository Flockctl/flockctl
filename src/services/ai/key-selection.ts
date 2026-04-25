import { getDb } from "../../db/index.js";
import { aiProviderKeys, projects, workspaces } from "../../db/schema.js";
import { eq, and, or, isNull, sql } from "drizzle-orm";

export interface KeySelection {
  id: number;
  provider: string;
  keyValue?: string | null;
  providerType: string;
  configDir?: string | null;
}

function safeParseJsonArray(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
 * Returns an empty array when no whitelist is configured at any level
 * (callers should treat "empty" as "no restriction").
 */
export function resolveAllowedKeyIds(task: {
  allowedKeyIds?: string | null;
  projectId?: number | null;
}): number[] {
  // 1. Task-level override (highest priority)
  if (task.allowedKeyIds) {
    return safeParseJsonArray(task.allowedKeyIds);
  }

  if (!task.projectId) return [];

  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
  if (!project) return [];

  // 2. Project-level override
  if (project.allowedKeyIds) {
    return safeParseJsonArray(project.allowedKeyIds);
  }

  // 3. Workspace-level fallback
  if (project.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
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

  // Filter out failed keys
  if (failedIds.length > 0) {
    candidates = candidates.filter(k => !failedIds.includes(k.id));
  }

  // Filter to allowed keys if specified
  if (allowedIds.length > 0) {
    candidates = candidates.filter(k => allowedIds.includes(k.id));
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
