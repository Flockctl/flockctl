import simpleGit from "simple-git";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function buildCodebaseContext(projectId: number): Promise<string> {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.path || !existsSync(project.path)) return "";

  const parts: string[] = [];

  // 1. File tree (max 3 levels, ignore node_modules/.git/dist)
  const tree = buildFileTree(project.path, 3);
  parts.push(`<file_tree>\n${tree}\n</file_tree>`);

  // 2. README
  for (const name of ["README.md", "readme.md", "README"]) {
    const readmePath = join(project.path, name);
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf-8").slice(0, 4000);
      parts.push(`<readme>\n${content}\n</readme>`);
      break;
    }
  }

  // 3. Git status (only if project is a git repo)
  if (existsSync(join(project.path, ".git"))) {
    try {
      const git = simpleGit(project.path);
      const status = await git.status();
      if (status.modified.length > 0 || status.not_added.length > 0) {
        const changed = [...status.modified, ...status.not_added].join("\n");
        parts.push(`<git_status>\n${changed}\n</git_status>`);
      }
    } catch (err) {
      console.warn("Git context error (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }

  return parts.join("\n\n");
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", ".flockctl"]);

function buildFileTree(dir: string, maxDepth: number, depth = 0): string {
  if (depth >= maxDepth) return "";
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  } catch {
    /* v8 ignore next — defensive: readdir fails on permission/race */
    return "";
  }
  return entries.map(e => {
    const prefix = "  ".repeat(depth);
    if (e.isDirectory()) {
      const sub = buildFileTree(join(dir, e.name), maxDepth, depth + 1);
      return `${prefix}${e.name}/\n${sub}`;
    }
    return `${prefix}${e.name}`;
  }).join("\n");
}
