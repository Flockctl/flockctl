import { join, dirname } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
} from "fs";
import { fileURLToPath } from "url";
import { getGlobalSkillsDir } from "./paths.js";

/**
 * Copy bundled skills to ~/flockctl/skills/ on first startup.
 * Skips skills that already exist (preserves user customizations).
 */
export function seedBundledSkills(): void {
  const globalDir = getGlobalSkillsDir();
  // bundled-skills/ sits next to the config/ folder in the dist/ or src/ tree
  const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bundled-skills");
  if (!existsSync(bundledDir)) return;

  mkdirSync(globalDir, { recursive: true });

  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = join(globalDir, entry.name);
    if (existsSync(dest)) continue; // don't overwrite user customizations
    cpSync(join(bundledDir, entry.name), dest, { recursive: true });
  }
}
