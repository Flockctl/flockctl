import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync,
} from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeFileAtomic, writeFileAtomicAsync } from "../../lib/fs-safe.js";
import { slugify } from "../../lib/slugify.js";

// ─── Helpers ───

export function getPlanDir(projectPath: string): string {
  return join(projectPath, ".flockctl", "plan");
}

/**
 * Reject slug inputs that would escape the plan directory when joined into a
 * file path. Plan-store helpers concatenate caller-supplied slugs into
 * `join(planDir, ...)` lookups, and slugs flow in from request bodies / query
 * params via `src/routes/planning.ts`. Without this gate a request like
 * `?milestone=../../etc&slice=passwd` could read arbitrary files. Validation
 * lives in the plan-store (not just the route) so every caller — auto-executor,
 * supervisor, future tooling — gets the same protection without re-deriving it.
 *
 * The accepted shape mirrors `slugify()` output (lowercase kebab-case) plus
 * underscores so existing tests and pre-feature plan files keep parsing.
 * Reject anything containing `..`, leading `.`, NUL bytes, or path separators.
 * The leading character must be alphanumeric to keep dotfiles out of the plan
 * tree (no `.git`, `.flockctl` look-ups via slug).
 */
export function assertSafePlanSlug(slug: string, kind = "slug"): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Invalid ${kind}: must be a non-empty string`);
  }
  if (!/^[a-z0-9][a-z0-9._\-]*$/.test(slug)) {
    throw new Error(
      `Invalid ${kind}: must match [a-z0-9][a-z0-9._\\-]*`,
    );
  }
  if (slug.includes("..") || slug.includes("\0")) {
    throw new Error(`Invalid ${kind}: must not contain '..' or NUL bytes`);
  }
}

export function toSlug(order: number, title: string): string {
  return `${String(order).padStart(2, "0")}-${slugify(title)}`;
}

export function parseOrder(slug: string): number {
  const match = slug.match(/^(\d+)-/);
  return match?.[1] !== undefined ? parseInt(match[1], 10) : 0;
}

export function parseMd(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const yamlSrc = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  try {
    return { frontmatter: parseYaml(yamlSrc) ?? {}, body };
  } catch (err) {
    // Agents sometimes emit invalid escape sequences inside double-quoted
    // YAML strings (e.g. `"@Environment(\.modelContext)"`). Sanitize and retry
    // once; on repeated failure fall back to an empty frontmatter so the rest
    // of the plan tree still loads.
    try {
      return { frontmatter: parseYaml(sanitizeYamlEscapes(yamlSrc)) ?? {}, body };
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
export function sanitizeYamlEscapes(yaml: string): string {
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

/**
 * Compose a `---\nyaml\n---\n\nbody\n` markdown blob from a frontmatter
 * object + body. Shared by `writeMd` (sync) and `writeMdAsync`.
 */
function composeMdContent(frontmatter: Record<string, unknown>, body: string): string {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trim();
  return body ? `---\n${yaml}\n---\n\n${body}\n` : `---\n${yaml}\n---\n`;
}

export function writeMd(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
  // Atomic tmp+rename so a concurrent reader (or a concurrent writer
  // from the auto-executor + missions paths racing on the same plan
  // file) never sees torn frontmatter. Audit-round-7 finding: the
  // previous `writeFileSync` allowed two writers to interleave bytes,
  // producing unparseable YAML on collision.
  writeFileAtomic(filePath, composeMdContent(frontmatter, body));
}

/**
 * Async sibling of {@link writeMd} for callers that can `await`
 * (route handlers, audit-round-5). Same on-disk shape; non-blocking
 * write so the event loop keeps serving concurrent requests.
 *
 * Uses `writeFileAtomicAsync` (audit-round-7) so concurrent edits
 * from the UI route + the auto-executor never tear frontmatter.
 */
export async function writeMdAsync(
  filePath: string,
  frontmatter: Record<string, any>,
  body: string,
): Promise<void> {
  await writeFileAtomicAsync(filePath, composeMdContent(frontmatter, body));
}

/**
 * Async sibling of {@link readFileSync} for callers in route handlers.
 * Exported here so `routes/planning.ts` doesn't reach into the bare
 * `fs/promises` module (consistency with the rest of the plan-store
 * surface).
 */
export async function readMdAsync(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

// Re-exported from `src/lib/fs-safe.ts` so the canonical definition lives in
// one place. Local re-export preserves every caller that imports from the
// plan-store barrel without a churn-risky search-and-replace.
export { ensureDir } from "../../lib/fs-safe.js";

export function sortedDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

/**
 * Cheap check: does the given file start with a YAML frontmatter block
 * (`---\n…\n---`)? Used to filter out plain markdown artefacts (audit reports,
 * notes, scratch files) that an agent may have dropped into a slice directory
 * but which are NOT plan entities and must not be picked up as pending tasks.
 *
 * Reads at most 8 KiB — frontmatter blocks are always at the top.
 */
export function hasYamlFrontmatter(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let head: string;
  try {
    // Read whole file; planning markdown files are tiny and a partial-read API
    // is not worth a fs.open dance here.
    head = readFileSync(filePath, "utf-8").slice(0, 8192);
  } catch {
    return false;
  }
  return /^---\n[\s\S]*?\n---/.test(head);
}

/**
 * List `*.md` files in a directory in lexicographic order, excluding
 * `slice.md`. By default only files with a YAML frontmatter block are
 * returned, so plan-store callers don't accidentally treat agent-emitted
 * artefact files (e.g. `AUDIT.md`, `NOTES.md`) as plan tasks.
 *
 * Pass `{ requireFrontmatter: false }` for the rare case where you want
 * every `*.md` regardless of shape (currently no caller needs this, but the
 * option keeps the door open for tooling that operates on raw files).
 */
export function sortedMdFiles(
  parentDir: string,
  options: { requireFrontmatter?: boolean } = {},
): string[] {
  const requireFrontmatter = options.requireFrontmatter ?? true;
  if (!existsSync(parentDir)) return [];
  const candidates = readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "slice.md")
    .map(e => e.name)
    .sort();
  if (!requireFrontmatter) return candidates;
  return candidates.filter(name => hasYamlFrontmatter(join(parentDir, name)));
}

export function nextOrder(parentDir: string, isDirs: boolean): number {
  const entries = isDirs ? sortedDirs(parentDir) : sortedMdFiles(parentDir);
  if (entries.length === 0) return 0;
  const last = entries[entries.length - 1]!;
  return parseOrder(last) + 1;
}

export function dedupeSlug(parentDir: string, slug: string, isDir: boolean): string {
  const check = isDir
    ? (s: string) => existsSync(join(parentDir, s))
    : (s: string) => existsSync(join(parentDir, s + ".md"));

  if (!check(slug)) return slug;
  let i = 2;
  while (check(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}
