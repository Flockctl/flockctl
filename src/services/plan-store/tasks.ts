import { existsSync, rmSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import type { PlanTaskData } from "./types.js";
import {
  getPlanDir,
  parseMd,
  writeMd,
  parseOrder,
  sortedMdFiles,
  nextOrder,
  dedupeSlug,
  toSlug,
  assertSafePlanSlug,
} from "./md-io.js";
import { jsonSafeParse } from "../../lib/json-safe-parse.js";
import { getDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import {
  setPlanTaskExecutionIndex,
  deletePlanTaskExecutionIndex,
  deletePlanTaskExecutionIndexByLocation,
} from "./execution-index.js";

/**
 * Resolve a project path to its DB primary key. Used by the plan-store
 * mutation paths to maintain `plan_task_execution_index`. Returns null
 * (and the index is left untouched) if the project path isn't registered
 * — keeps standalone / orphan plan trees from spamming the index with
 * dangling rows.
 *
 * Single-row read by indexed column; cheap to call on every write.
 */
function lookupProjectIdByPath(projectPath: string): number | null {
  const db = getDb();
  const row = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.path, projectPath))
    .get();
  return row?.id ?? null;
}

/**
 * Maintain the inverse index for one plan task. Called from the create /
 * update writers: when the task carries an `executionTaskId`, we UPSERT
 * the (exec → location) row; when it doesn't, we make sure any prior row
 * for this location is cleared (handles the "exec id explicitly unset"
 * path).
 *
 * Wrapped in a try/catch because index maintenance MUST NOT block a
 * legitimate plan-task write — if the SQLite write fails (rare; e.g.
 * concurrent migration), the auto-executor's fallback FS walk repairs
 * the index on the next resolve.
 */
function syncExecutionIndexForTask(
  projectPath: string,
  milestoneSlug: string,
  sliceSlug: string,
  taskSlug: string,
  executionTaskId: number | undefined | null,
): void {
  try {
    const projectId = lookupProjectIdByPath(projectPath);
    if (projectId === null) return;
    if (executionTaskId != null && Number.isFinite(executionTaskId)) {
      setPlanTaskExecutionIndex(executionTaskId, {
        projectId,
        milestoneSlug,
        sliceSlug,
        taskSlug,
      });
    } else {
      // Plan task no longer carries an exec id — drop any stale row that
      // pointed AT this location (best-effort: ON CONFLICT semantics mean
      // a delete is idempotent).
      deletePlanTaskExecutionIndexByLocation(
        projectId,
        milestoneSlug,
        sliceSlug,
        taskSlug,
      );
    }
  } catch {
    // Defensive: index drift is self-healing via the FS-walk fallback.
  }
}

// ─── PlanTask frontmatter mapping ───

export function taskFromFile(slug: string, milestoneSlug: string, sliceSlug: string, fm: Record<string, any>, body: string): PlanTaskData {
  return {
    slug,
    milestoneSlug,
    sliceSlug,
    title: fm.title ?? slug,
    status: fm.status ?? "pending",
    order: fm.order ?? parseOrder(slug),
    model: fm.model,
    estimate: fm.estimate,
    files: fm.files,
    verify: fm.verify,
    depends: fm.depends,
    inputs: fm.inputs,
    expectedOutput: fm.expected_output,
    executionTaskId: fm.execution_task_id,
    output: fm.output,
    summary: fm.summary,
    verificationPassed: fm.verification_passed,
    verificationOutput: fm.verification_output,
    failureModes: fm.failure_modes,
    negativeTests: fm.negative_tests,
    observabilityImpact: fm.observability_impact,
    description: body || undefined,
    createdAt: fm.created_at,
    updatedAt: fm.updated_at,
  };
}

export function taskToFrontmatter(data: Partial<PlanTaskData>): Record<string, any> {
  return {
    title: data.title,
    status: data.status,
    order: data.order,
    model: data.model,
    estimate: data.estimate,
    files: data.files,
    verify: data.verify,
    depends: data.depends,
    inputs: data.inputs,
    expected_output: data.expectedOutput,
    execution_task_id: data.executionTaskId,
    output: data.output,
    summary: data.summary,
    verification_passed: data.verificationPassed,
    verification_output: data.verificationOutput,
    failure_modes: data.failureModes,
    negative_tests: data.negativeTests,
    observability_impact: data.observabilityImpact,
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  };
}

// ─── API mapping (camelCase → snake_case for frontend) ───

export function taskToApi(t: PlanTaskData): Record<string, any> {
  return {
    id: t.slug,
    slice_id: t.sliceSlug,
    title: t.title,
    description: t.description ?? null,
    model: t.model ?? null,
    status: t.status,
    estimate: t.estimate ?? null,
    files: t.files ?? null,
    verify: t.verify ?? null,
    inputs: t.inputs ?? null,
    expected_output: t.expectedOutput ?? null,
    task_id: t.executionTaskId?.toString() ?? null,
    order_index: t.order,
    output: t.output ?? null,
    // `summary` is JSON-encoded TEXT in the markdown frontmatter — defend
    // against a corrupted blob so one bad task doesn't poison the entire
    // plan-tree response. Falls back to raw string when JSON parse fails so
    // forensics can still see the content.
    summary: t.summary
      ? typeof t.summary === "string"
        ? (jsonSafeParse<unknown>(t.summary) ?? t.summary)
        : t.summary
      : null,
    verification_passed: t.verificationPassed ?? null,
    verification_output: t.verificationOutput ?? null,
    created_at: t.createdAt ?? "",
    updated_at: t.updatedAt ?? "",
  };
}

// ─── Plan Tasks ───

export function listPlanTasks(projectPath: string, milestoneSlug: string, sliceSlug: string): PlanTaskData[] {
  assertSafePlanSlug(milestoneSlug, "milestone slug");
  assertSafePlanSlug(sliceSlug, "slice slug");
  const sliceDir = join(getPlanDir(projectPath), milestoneSlug, sliceSlug);
  const files = sortedMdFiles(sliceDir);

  return files.map(filename => {
    const slug = filename.replace(/\.md$/, "");
    const { frontmatter, body } = parseMd(join(sliceDir, filename));
    return taskFromFile(slug, milestoneSlug, sliceSlug, frontmatter, body);
  });
}

export function getPlanTask(projectPath: string, milestoneSlug: string, sliceSlug: string, slug: string): PlanTaskData | null {
  assertSafePlanSlug(milestoneSlug, "milestone slug");
  assertSafePlanSlug(sliceSlug, "slice slug");
  assertSafePlanSlug(slug, "task slug");
  const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${slug}.md`);
  if (!existsSync(mdPath)) return null;
  const { frontmatter, body } = parseMd(mdPath);
  return taskFromFile(slug, milestoneSlug, sliceSlug, frontmatter, body);
}

export function createPlanTask(
  projectPath: string, milestoneSlug: string, sliceSlug: string,
  data: Partial<PlanTaskData>,
): PlanTaskData {
  assertSafePlanSlug(milestoneSlug, "milestone slug");
  assertSafePlanSlug(sliceSlug, "slice slug");
  const sliceDir = join(getPlanDir(projectPath), milestoneSlug, sliceSlug);
  if (!existsSync(join(sliceDir, "slice.md"))) {
    throw new Error(`Slice not found: ${sliceSlug}`);
  }

  const order = data.order ?? nextOrder(sliceDir, false);
  const slug = dedupeSlug(sliceDir, toSlug(order, data.title ?? "task"), false);
  const mdPath = join(sliceDir, `${slug}.md`);

  const now = new Date().toISOString();
  const full: PlanTaskData = {
    slug,
    milestoneSlug,
    sliceSlug,
    title: data.title ?? "Untitled Task",
    status: data.status ?? "pending",
    order,
    model: data.model,
    estimate: data.estimate,
    files: data.files,
    verify: data.verify,
    depends: data.depends,
    inputs: data.inputs,
    expectedOutput: data.expectedOutput,
    executionTaskId: data.executionTaskId,
    output: data.output,
    summary: data.summary,
    verificationPassed: data.verificationPassed,
    verificationOutput: data.verificationOutput,
    failureModes: data.failureModes,
    negativeTests: data.negativeTests,
    observabilityImpact: data.observabilityImpact,
    description: data.description,
    createdAt: now,
    updatedAt: now,
  };

  writeMd(mdPath, taskToFrontmatter(full), full.description ?? "");
  syncExecutionIndexForTask(
    projectPath,
    milestoneSlug,
    sliceSlug,
    slug,
    full.executionTaskId,
  );
  return full;
}

export function updatePlanTask(
  projectPath: string, milestoneSlug: string, sliceSlug: string,
  slug: string, data: Partial<PlanTaskData>,
): PlanTaskData {
  assertSafePlanSlug(milestoneSlug, "milestone slug");
  assertSafePlanSlug(sliceSlug, "slice slug");
  assertSafePlanSlug(slug, "task slug");
  const existing = getPlanTask(projectPath, milestoneSlug, sliceSlug, slug);
  if (!existing) throw new Error(`Plan task not found: ${slug}`);

  const merged: PlanTaskData = {
    ...existing,
    ...Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined)),
    slug,
    milestoneSlug,
    sliceSlug,
    updatedAt: new Date().toISOString(),
  };

  const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${slug}.md`);
  writeMd(mdPath, taskToFrontmatter(merged), merged.description ?? "");
  // If the exec id changed, the old row in the index must be purged
  // (otherwise a stale (oldExecId → location) entry would linger). The
  // sync helper writes the new (newExecId → location) row.
  if (
    existing.executionTaskId != null &&
    existing.executionTaskId !== merged.executionTaskId
  ) {
    try {
      deletePlanTaskExecutionIndex(existing.executionTaskId);
    } catch {
      /* drift is self-healing */
    }
  }
  syncExecutionIndexForTask(
    projectPath,
    milestoneSlug,
    sliceSlug,
    slug,
    merged.executionTaskId,
  );
  return merged;
}

export function deletePlanTask(projectPath: string, milestoneSlug: string, sliceSlug: string, slug: string): void {
  assertSafePlanSlug(milestoneSlug, "milestone slug");
  assertSafePlanSlug(sliceSlug, "slice slug");
  assertSafePlanSlug(slug, "task slug");
  const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${slug}.md`);
  if (!existsSync(mdPath)) throw new Error(`Plan task not found: ${slug}`);
  // Read existing exec id BEFORE rm so we can drop the index row.
  let existingExecId: number | undefined;
  try {
    const { frontmatter } = parseMd(mdPath);
    const v = frontmatter.execution_task_id;
    if (typeof v === "number") existingExecId = v;
  } catch {
    /* unreadable plan task — proceed with delete anyway */
  }
  rmSync(mdPath);
  if (existingExecId != null) {
    try {
      deletePlanTaskExecutionIndex(existingExecId);
    } catch {
      /* drift is self-healing */
    }
  }
}
