/**
 * FS-based planning store.
 * Milestones, slices, and plan tasks live as markdown files with YAML frontmatter
 * inside {projectPath}/.flockctl/plan/
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, rmSync, statSync,
} from "fs";
import { join, basename } from "path";
import { slugify } from "../lib/slugify.js";

// ─── Types ───

export interface MilestoneData {
  slug: string;
  title: string;
  status: string;
  order: number;
  vision?: string;
  description?: string;
  successCriteria?: string[];
  dependsOn?: string[];
  keyRisks?: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  boundaryMapMarkdown?: string;
  verificationContract?: string;
  verificationIntegration?: string;
  verificationOperational?: string;
  verificationUat?: string;
  definitionOfDone?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SliceData {
  slug: string;
  milestoneSlug: string;
  title: string;
  status: string;
  order: number;
  risk?: string;
  depends?: string[];
  goal?: string;
  demo?: string;
  successCriteria?: string;
  proofLevel?: string;
  integrationClosure?: string;
  observabilityImpact?: string;
  threatSurface?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanTaskData {
  slug: string;
  sliceSlug: string;
  milestoneSlug: string;
  title: string;
  status: string;
  order: number;
  model?: string;
  estimate?: string;
  files?: string[];
  verify?: string;
  depends?: string[];
  inputs?: string[];
  expectedOutput?: string[];
  executionTaskId?: number;
  output?: string;
  summary?: string;
  verificationPassed?: boolean;
  verificationOutput?: string;
  failureModes?: Array<{ depFails: string; taskBehavior: string }>;
  negativeTests?: string[];
  observabilityImpact?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Helpers ───

export function getPlanDir(projectPath: string): string {
  return join(projectPath, ".flockctl", "plan");
}

export function toSlug(order: number, title: string): string {
  return `${String(order).padStart(2, "0")}-${slugify(title)}`;
}

export function parseOrder(slug: string): number {
  const match = slug.match(/^(\d+)-/);
  return match ? parseInt(match[1]) : 0;
}

export function parseMd(filePath: string): { frontmatter: Record<string, any>; body: string } {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const body = match[2].trim();

  try {
    return { frontmatter: parseYaml(match[1]) ?? {}, body };
  } catch (err) {
    // Agents sometimes emit invalid escape sequences inside double-quoted
    // YAML strings (e.g. `"@Environment(\.modelContext)"`). Sanitize and retry
    // once; on repeated failure fall back to an empty frontmatter so the rest
    // of the plan tree still loads.
    try {
      return { frontmatter: parseYaml(sanitizeYamlEscapes(match[1])) ?? {}, body };
    } catch (err2) {
      /* v8 ignore start — defensive: sanitize-then-parse fallback for malformed YAML */
      const msg = err2 instanceof Error ? err2.message : String(err2);
      console.warn(`[plan-store] Failed to parse YAML in ${filePath}: ${msg}`);
      return { frontmatter: {}, body };
      /* v8 ignore stop */
    }
  }
}

// In YAML, double-quoted strings only allow a small set of backslash escapes
// (`\0 \a \b \t \n \v \f \r \e \" \/ \\ \N \_ \L \P \x \u \U`, plus space/tab
// for line continuation). Any other `\X` is a parse error. Double a stray
// backslash so the string survives round-trip through the parser.
const VALID_DQ_ESCAPE = new Set([
  "0", "a", "b", "t", "n", "v", "f", "r", "e",
  '"', "/", "\\", "N", "_", "L", "P", "x", "u", "U",
  " ", "\t", "\n",
]);
function sanitizeYamlEscapes(yaml: string): string {
  return yaml.replace(
    /"((?:[^"\\]|\\.)*)"/g,
    (_full, inner: string) => {
      const fixed = inner.replace(/\\(.)/g, (esc, ch) =>
        VALID_DQ_ESCAPE.has(ch) ? esc : `\\\\${ch}`,
      );
      return `"${fixed}"`;
    },
  );
}

export function writeMd(filePath: string, frontmatter: Record<string, any>, body: string): void {
  // Remove undefined values from frontmatter
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trim();
  const content = body ? `---\n${yaml}\n---\n\n${body}\n` : `---\n${yaml}\n---\n`;
  writeFileSync(filePath, content, "utf-8");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sortedDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

function sortedMdFiles(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "slice.md")
    .map(e => e.name)
    .sort();
}

function nextOrder(parentDir: string, isDirs: boolean): number {
  const entries = isDirs ? sortedDirs(parentDir) : sortedMdFiles(parentDir);
  if (entries.length === 0) return 0;
  const last = entries[entries.length - 1];
  return parseOrder(last) + 1;
}

function dedupeSlug(parentDir: string, slug: string, isDir: boolean): string {
  const check = isDir
    ? (s: string) => existsSync(join(parentDir, s))
    : (s: string) => existsSync(join(parentDir, s + ".md"));

  if (!check(slug)) return slug;
  let i = 2;
  while (check(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// ─── Milestone frontmatter mapping ───

function milestoneFromFile(slug: string, fm: Record<string, any>, body: string): MilestoneData {
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
    createdAt: fm.created_at,
    updatedAt: fm.updated_at,
  };
}

function milestoneToFrontmatter(data: Partial<MilestoneData>): Record<string, any> {
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
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  };
}

// ─── Slice frontmatter mapping ───

function sliceFromFile(slug: string, milestoneSlug: string, fm: Record<string, any>, body: string): SliceData {
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

function sliceToFrontmatter(data: Partial<SliceData>): Record<string, any> {
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

// ─── PlanTask frontmatter mapping ───

function taskFromFile(slug: string, milestoneSlug: string, sliceSlug: string, fm: Record<string, any>, body: string): PlanTaskData {
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

function taskToFrontmatter(data: Partial<PlanTaskData>): Record<string, any> {
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

// ─── API mapping (camelCase → snake_case for frontend) ───

function milestoneToApi(m: MilestoneData): Record<string, any> {
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

function sliceToApi(s: SliceData): Record<string, any> {
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

function taskToApi(t: PlanTaskData): Record<string, any> {
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

// ─── Tree ───

export function getProjectTree(projectPath: string): {
  milestones: Array<Record<string, any>>;
} {
  const ms = listMilestones(projectPath);
  return {
    milestones: ms.map(m => {
      const slices = listSlices(projectPath, m.slug);
      return {
        ...milestoneToApi(m),
        slices: slices.map(s => {
          const tasks = listPlanTasks(projectPath, m.slug, s.slug);
          return {
            ...sliceToApi(s),
            tasks: tasks.map(taskToApi),
          };
        }),
      };
    }),
  };
}
