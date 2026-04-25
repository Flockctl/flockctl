import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { slugify } from "../../lib/slugify.js";

// ─── Helpers ───

export function getPlanDir(projectPath: string): string {
  return join(projectPath, ".flockctl", "plan");
}

export function toSlug(order: number, title: string): string {
  return `${String(order).padStart(2, "0")}-${slugify(title)}`;
}

export function parseOrder(slug: string): number {
  const match = slug.match(/^(\d+)-/);
  return match?.[1] !== undefined ? parseInt(match[1]) : 0;
}

export function parseMd(filePath: string): { frontmatter: Record<string, any>; body: string } {
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

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function sortedDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

export function sortedMdFiles(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "slice.md")
    .map(e => e.name)
    .sort();
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
