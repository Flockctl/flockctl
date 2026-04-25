import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { MilestoneData } from "./types.js";
import {
  getPlanDir,
  parseMd,
  writeMd,
  parseOrder,
  ensureDir,
  sortedDirs,
  nextOrder,
  dedupeSlug,
  toSlug,
} from "./md-io.js";

// ─── Milestone frontmatter mapping ───

export function milestoneFromFile(slug: string, fm: Record<string, any>, body: string): MilestoneData {
  return {
    slug,
    title: fm.title ?? slug,
    status: fm.status ?? "pending",
    order: fm.order ?? parseOrder(slug),
    vision: fm.vision,
    description: body || undefined,
    successCriteria: fm.success_criteria,
    dependsOn: fm.depends_on,
    keyRisks: fm.key_risks,
    proofStrategy: fm.proof_strategy,
    boundaryMapMarkdown: fm.boundary_map_markdown,
    verificationContract: fm.verification_contract,
    verificationIntegration: fm.verification_integration,
    verificationOperational: fm.verification_operational,
    verificationUat: fm.verification_uat,
    definitionOfDone: fm.definition_of_done,
    // Existing plans (pre-feature) have no `spec_required` key in their
    // frontmatter — treat that as opt-out so we don't retroactively block
    // ready transitions on plans authored before the gate existed.
    specRequired: typeof fm.spec_required === "boolean" ? fm.spec_required : false,
    createdAt: fm.created_at,
    updatedAt: fm.updated_at,
  };
}

export function milestoneToFrontmatter(data: Partial<MilestoneData>): Record<string, any> {
  return {
    title: data.title,
    status: data.status,
    order: data.order,
    vision: data.vision,
    success_criteria: data.successCriteria,
    depends_on: data.dependsOn,
    key_risks: data.keyRisks,
    proof_strategy: data.proofStrategy,
    boundary_map_markdown: data.boundaryMapMarkdown,
    verification_contract: data.verificationContract,
    verification_integration: data.verificationIntegration,
    verification_operational: data.verificationOperational,
    verification_uat: data.verificationUat,
    definition_of_done: data.definitionOfDone,
    spec_required: data.specRequired,
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  };
}

// ─── API mapping (camelCase → snake_case for frontend) ───

export function milestoneToApi(m: MilestoneData): Record<string, any> {
  return {
    id: m.slug,
    title: m.title,
    description: m.description ?? null,
    status: m.status,
    vision: m.vision ?? null,
    success_criteria: m.successCriteria ?? null,
    depends_on: m.dependsOn ?? null,
    order_index: m.order,
    key_risks: m.keyRisks ?? null,
    proof_strategy: m.proofStrategy ?? null,
    boundary_map_markdown: m.boundaryMapMarkdown ?? null,
    definition_of_done: m.definitionOfDone ?? null,
    created_at: m.createdAt ?? "",
    updated_at: m.updatedAt ?? "",
  };
}

// ─── Milestones ───

export function listMilestones(projectPath: string): MilestoneData[] {
  const planDir = getPlanDir(projectPath);
  const dirs = sortedDirs(planDir);

  return dirs.map(slug => {
    const mdPath = join(planDir, slug, "milestone.md");
    if (!existsSync(mdPath)) return null;
    const { frontmatter, body } = parseMd(mdPath);
    return milestoneFromFile(slug, frontmatter, body);
  }).filter(Boolean) as MilestoneData[];
}

export function getMilestone(projectPath: string, slug: string): MilestoneData | null {
  const mdPath = join(getPlanDir(projectPath), slug, "milestone.md");
  if (!existsSync(mdPath)) return null;
  const { frontmatter, body } = parseMd(mdPath);
  return milestoneFromFile(slug, frontmatter, body);
}

export function createMilestone(projectPath: string, data: Partial<MilestoneData>): MilestoneData {
  const planDir = getPlanDir(projectPath);
  ensureDir(planDir);

  const order = data.order ?? nextOrder(planDir, true);
  const slug = dedupeSlug(planDir, toSlug(order, data.title ?? "milestone"), true);
  const dir = join(planDir, slug);
  ensureDir(dir);

  const now = new Date().toISOString();
  const full: MilestoneData = {
    slug,
    title: data.title ?? "Untitled Milestone",
    status: data.status ?? "pending",
    order,
    vision: data.vision,
    description: data.description,
    successCriteria: data.successCriteria,
    dependsOn: data.dependsOn,
    keyRisks: data.keyRisks,
    proofStrategy: data.proofStrategy,
    boundaryMapMarkdown: data.boundaryMapMarkdown,
    verificationContract: data.verificationContract,
    verificationIntegration: data.verificationIntegration,
    verificationOperational: data.verificationOperational,
    verificationUat: data.verificationUat,
    definitionOfDone: data.definitionOfDone,
    // New plans default to spec-required. Callers that want a lenient plan
    // (e.g. imports, agent-generated scratch milestones) can pass
    // `specRequired: false` explicitly.
    specRequired: data.specRequired ?? true,
    createdAt: now,
    updatedAt: now,
  };

  writeMd(join(dir, "milestone.md"), milestoneToFrontmatter(full), full.description ?? "");
  return full;
}

export function updateMilestone(projectPath: string, slug: string, data: Partial<MilestoneData>): MilestoneData {
  const existing = getMilestone(projectPath, slug);
  if (!existing) throw new Error(`Milestone not found: ${slug}`);

  const merged: MilestoneData = {
    ...existing,
    ...Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined)),
    slug, // slug stays
    updatedAt: new Date().toISOString(),
  };

  const dir = join(getPlanDir(projectPath), slug);
  writeMd(join(dir, "milestone.md"), milestoneToFrontmatter(merged), merged.description ?? "");
  return merged;
}

export function deleteMilestone(projectPath: string, slug: string): void {
  const dir = join(getPlanDir(projectPath), slug);
  if (!existsSync(dir)) throw new Error(`Milestone not found: ${slug}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Find the milestone that owns a given slice slug.
 *
 * Slice slugs are unique *within* a milestone (via `dedupeSlug`), but nothing
 * guarantees uniqueness across milestones — so we walk the milestones in order
 * and return the first owner. That matches the order the task was authored in
 * (auto-executor creates tasks as it walks the plan) and is stable because
 * `sortedDirs` sorts lexicographically by the order-prefixed slug.
 *
 * Used by the task authoring gate (`PUT /tasks/:id`) to resolve
 * `targetSliceSlug` → `plan.specRequired` without requiring callers to pass a
 * milestone slug explicitly.
 */
export function findMilestoneBySlice(projectPath: string, sliceSlug: string): MilestoneData | null {
  const milestones = listMilestones(projectPath);
  for (const m of milestones) {
    const milestoneDir = join(getPlanDir(projectPath), m.slug);
    if (existsSync(join(milestoneDir, sliceSlug, "slice.md"))) return m;
  }
  return null;
}
