import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { SliceData } from "./types.js";
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

// ─── Slice frontmatter mapping ───

export function sliceFromFile(slug: string, milestoneSlug: string, fm: Record<string, any>, body: string): SliceData {
  return {
    slug,
    milestoneSlug,
    title: fm.title ?? slug,
    status: fm.status ?? "pending",
    order: fm.order ?? parseOrder(slug),
    risk: fm.risk,
    depends: fm.depends,
    goal: fm.goal,
    demo: fm.demo,
    successCriteria: fm.success_criteria,
    proofLevel: fm.proof_level,
    integrationClosure: fm.integration_closure,
    observabilityImpact: fm.observability_impact,
    threatSurface: fm.threat_surface,
    description: body || undefined,
    createdAt: fm.created_at,
    updatedAt: fm.updated_at,
  };
}

export function sliceToFrontmatter(data: Partial<SliceData>): Record<string, any> {
  return {
    title: data.title,
    status: data.status,
    order: data.order,
    risk: data.risk,
    depends: data.depends,
    goal: data.goal,
    demo: data.demo,
    success_criteria: data.successCriteria,
    proof_level: data.proofLevel,
    integration_closure: data.integrationClosure,
    observability_impact: data.observabilityImpact,
    threat_surface: data.threatSurface,
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  };
}

// ─── API mapping (camelCase → snake_case for frontend) ───

export function sliceToApi(s: SliceData): Record<string, any> {
  return {
    id: s.slug,
    milestone_id: s.milestoneSlug,
    title: s.title,
    description: s.description ?? null,
    status: s.status,
    risk: s.risk ?? "medium",
    depends: s.depends ?? null,
    demo: s.demo ?? null,
    goal: s.goal ?? null,
    success_criteria: s.successCriteria ?? null,
    order_index: s.order,
    created_at: s.createdAt ?? "",
    updated_at: s.updatedAt ?? "",
  };
}

// ─── Slices ───

export function listSlices(projectPath: string, milestoneSlug: string): SliceData[] {
  const milestoneDir = join(getPlanDir(projectPath), milestoneSlug);
  const dirs = sortedDirs(milestoneDir);

  return dirs.map(slug => {
    const mdPath = join(milestoneDir, slug, "slice.md");
    if (!existsSync(mdPath)) return null;
    const { frontmatter, body } = parseMd(mdPath);
    return sliceFromFile(slug, milestoneSlug, frontmatter, body);
  }).filter(Boolean) as SliceData[];
}

export function getSlice(projectPath: string, milestoneSlug: string, slug: string): SliceData | null {
  const mdPath = join(getPlanDir(projectPath), milestoneSlug, slug, "slice.md");
  if (!existsSync(mdPath)) return null;
  const { frontmatter, body } = parseMd(mdPath);
  return sliceFromFile(slug, milestoneSlug, frontmatter, body);
}

export function createSlice(projectPath: string, milestoneSlug: string, data: Partial<SliceData>): SliceData {
  const milestoneDir = join(getPlanDir(projectPath), milestoneSlug);
  if (!existsSync(join(milestoneDir, "milestone.md"))) {
    throw new Error(`Milestone not found: ${milestoneSlug}`);
  }

  const order = data.order ?? nextOrder(milestoneDir, true);
  const slug = dedupeSlug(milestoneDir, toSlug(order, data.title ?? "slice"), true);
  const dir = join(milestoneDir, slug);
  ensureDir(dir);

  const now = new Date().toISOString();
  const full: SliceData = {
    slug,
    milestoneSlug,
    title: data.title ?? "Untitled Slice",
    status: data.status ?? "pending",
    order,
    risk: data.risk,
    depends: data.depends,
    goal: data.goal,
    demo: data.demo,
    successCriteria: data.successCriteria,
    proofLevel: data.proofLevel,
    integrationClosure: data.integrationClosure,
    observabilityImpact: data.observabilityImpact,
    threatSurface: data.threatSurface,
    description: data.description,
    createdAt: now,
    updatedAt: now,
  };

  writeMd(join(dir, "slice.md"), sliceToFrontmatter(full), full.description ?? "");
  return full;
}

export function updateSlice(projectPath: string, milestoneSlug: string, slug: string, data: Partial<SliceData>): SliceData {
  const existing = getSlice(projectPath, milestoneSlug, slug);
  if (!existing) throw new Error(`Slice not found: ${slug}`);

  const merged: SliceData = {
    ...existing,
    ...Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined)),
    slug,
    milestoneSlug,
    updatedAt: new Date().toISOString(),
  };

  const dir = join(getPlanDir(projectPath), milestoneSlug, slug);
  writeMd(join(dir, "slice.md"), sliceToFrontmatter(merged), merged.description ?? "");
  return merged;
}

export function deleteSlice(projectPath: string, milestoneSlug: string, slug: string): void {
  const dir = join(getPlanDir(projectPath), milestoneSlug, slug);
  if (!existsSync(dir)) throw new Error(`Slice not found: ${slug}`);
  rmSync(dir, { recursive: true, force: true });
}
