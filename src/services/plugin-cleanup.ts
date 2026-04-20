import { existsSync, readFileSync, rmSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getFlockctlHome } from "../config.js";

const MARKETPLACE_KEY = "flockctl-local";
const PLUGIN_KEY = "flockctl@flockctl-local";

/**
 * One-shot cleanup of the Claude Code plugin artifacts seeded by the
 * pre-reconciler era. Runs on every boot (idempotent) so users who upgrade
 * pick it up without a flag.
 *
 * - Removes ~/flockctl/.claude-plugin/ entirely.
 * - Strips flockctl entries from ~/.claude/settings.json, preserving unrelated keys.
 */
export function cleanupClaudeCodePlugin(): void {
  removePluginDir();
  cleanupClaudeSettings();
}

function removePluginDir(): void {
  const pluginDir = join(getFlockctlHome(), ".claude-plugin");
  if (!existsSync(pluginDir)) return;
  try {
    rmSync(pluginDir, { recursive: true, force: true });
  } catch (err) {
    /* v8 ignore next — defensive: rmSync rarely fails on cleanup */
    console.warn(`[plugin-cleanup] failed to remove ${pluginDir}:`, err);
  }
}

function cleanupClaudeSettings(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (err) {
    /* v8 ignore next 2 — defensive: readFile fails only on permission/race */
    console.warn(`[plugin-cleanup] cannot read ${settingsPath}:`, err);
    return;
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[plugin-cleanup] malformed ${settingsPath}, skipping:`, err);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  let changed = false;
  if (parsed.extraKnownMarketplaces && typeof parsed.extraKnownMarketplaces === "object") {
    if (MARKETPLACE_KEY in parsed.extraKnownMarketplaces) {
      delete parsed.extraKnownMarketplaces[MARKETPLACE_KEY];
      changed = true;
    }
  }
  if (parsed.enabledPlugins && typeof parsed.enabledPlugins === "object") {
    if (PLUGIN_KEY in parsed.enabledPlugins) {
      delete parsed.enabledPlugins[PLUGIN_KEY];
      changed = true;
    }
  }

  if (!changed) return;

  const out = JSON.stringify(parsed, null, 2) + "\n";
  const tmpPath = settingsPath + ".tmp";
  try {
    writeFileSync(tmpPath, out, "utf-8");
    renameSync(tmpPath, settingsPath);
  } catch (err) {
    /* v8 ignore next — defensive: write fails only on permission/disk-full */
    console.warn(`[plugin-cleanup] failed to write ${settingsPath}:`, err);
  }
}
