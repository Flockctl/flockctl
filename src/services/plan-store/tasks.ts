import { existsSync, rmSync } from "fs";
import { join } from "path";
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
} from "./md-io.js";

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
    summary: t.summary ? (typeof t.summary === "string" ? JSON.parse(t.summary) : t.summary) : null,
    verification_passed: t.verificationPassed ?? null,
    verification_output: t.verificationOutput ?? null,
    created_at: t.createdAt ?? "",
    updated_at: t.updatedAt ?? "",
  };
}

// ─── Plan Tasks ───

export function listPlanTasks(projectPath: string, milestoneSlug: string, sliceSlug: string): PlanTaskData[] {
  const sliceDir = join(getPlanDir(projectPath), milestoneSlug, sliceSlug);
  const files = sortedMdFiles(sliceDir);

  return files.map(filename => {
    const slug = filename.replace(/\.md$/, "");
    const { frontmatter, body } = parseMd(join(sliceDir, filename));
    return taskFromFile(slug, milestoneSlug, sliceSlug, frontmatter, body);
  });
}

export function getPlanTask(projectPath: string, milestoneSlug: string, sliceSlug: string, slug: string): PlanTaskData | null {
  const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${slug}.md`);
  if (!existsSync(mdPath)) return null;
  const { frontmatter, body } = parseMd(mdPath);
  return taskFromFile(slug, milestoneSlug, sliceSlug, frontmatter, body);
}

export function createPlanTask(
  projectPath: string, milestoneSlug: string, sliceSlug: string,
  data: Partial<PlanTaskData>,
): PlanTaskData {
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
  return full;
}

export function updatePlanTask(
  projectPath: string, milestoneSlug: string, sliceSlug: string,
  slug: string, data: Partial<PlanTaskData>,
): PlanTaskData {
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
  return merged;
}

export function deletePlanTask(projectPath: string, milestoneSlug: string, sliceSlug: string, slug: string): void {
  const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${slug}.md`);
  if (!existsSync(mdPath)) throw new Error(`Plan task not found: ${slug}`);
  rmSync(mdPath);
}
