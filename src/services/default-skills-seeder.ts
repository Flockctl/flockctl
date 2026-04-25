import { join, dirname } from "path";
import { existsSync, mkdirSync, readdirSync, cpSync } from "fs";
import { fileURLToPath } from "url";
import { getGlobalSkillsDir } from "../config/index.js";

/**
 * Copy every skill from `src/resources/default-skills/` (shipped inside the
 * package) into `~/flockctl/skills/` on boot.
 *
 * Idempotent: a destination directory that already exists is never touched
 * — this preserves user edits across restarts. The presence of the target
 * folder IS the "don't re-seed" marker; we do not use mtime comparisons so
 * that a user who clears a file (but leaves the directory) still keeps
 * their edits.
 */
export function seedDefaultSkills(): { seeded: string[]; skipped: string[] } {
  const result = { seeded: [] as string[], skipped: [] as string[] };

  // resources/default-skills/ is copied next to this file during build
  // (see package.json "build" script). In source/dev mode it lives at
  // ../resources/default-skills relative to this compiled file.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourceDir = join(moduleDir, "..", "resources", "default-skills");
  if (!existsSync(sourceDir)) return result;

  const globalDir = getGlobalSkillsDir();
  mkdirSync(globalDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = join(globalDir, entry.name);
    if (existsSync(dest)) {
      // Target exists — user may have edited it. Never overwrite.
      result.skipped.push(entry.name);
      continue;
    }
    cpSync(join(sourceDir, entry.name), dest, { recursive: true });
    result.seeded.push(entry.name);
  }

  return result;
}
