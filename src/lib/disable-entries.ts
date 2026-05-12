// Shared helpers for "disabled skills / MCP servers" entries.
//
// Audit-round-7 finding: `routes/skills.ts` and `routes/mcp.ts` both
// defined identical local copies of `validateDisableBody`,
// `entriesAddUnique`, and `entriesRemove`. Lifted into a shared lib so
// the validation rules (and any future tightening) live in one place
// and the two routes can't drift.

import { ValidationError } from "./errors.js";
import type {
  DisableEntry,
  DisableLevel,
} from "../services/workspace-config.js";

/** Closed enum of valid disable levels. Mirrors `DisableLevel`. */
const VALID_LEVELS: ReadonlySet<DisableLevel> = new Set<DisableLevel>([
  "global",
  "workspace",
  "project",
]);

/**
 * Validate + narrow an incoming `{ name, level }` body. Throws
 * `ValidationError` on shape failure. The `allowedLevels` arg lets the
 * caller restrict which levels are addressable from the current scope
 * (e.g. a workspace-level endpoint accepts "global" + "workspace" but
 * not "project").
 *
 * Body is typed `unknown` rather than `any` so callers narrow inside.
 */
export function validateDisableBody(
  body: unknown,
  allowedLevels: DisableLevel[],
): DisableEntry {
  if (!body || typeof body !== "object") {
    throw new ValidationError("body required");
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new ValidationError("name is required");
  }
  if (typeof obj.level !== "string" || !VALID_LEVELS.has(obj.level as DisableLevel)) {
    throw new ValidationError(
      "level must be one of 'global' | 'workspace' | 'project'",
    );
  }
  const level = obj.level as DisableLevel;
  if (!allowedLevels.includes(level)) {
    throw new ValidationError(
      `level '${level}' is not addressable from this config scope`,
    );
  }
  return { name: obj.name, level };
}

/**
 * Add `entry` to `entries` if it isn't already present (`name + level`
 * uniqueness). Returns the original array on no-op so callers can do
 * `prev === next` reference equality to skip writes.
 */
export function entriesAddUnique(
  entries: DisableEntry[],
  entry: DisableEntry,
): DisableEntry[] {
  if (entries.some((e) => e.name === entry.name && e.level === entry.level)) {
    return entries;
  }
  return [...entries, entry];
}

/**
 * Remove every entry matching `(name, level)` from `entries`. Returns a
 * new array even when nothing matches (cheap; the caller writes anyway).
 */
export function entriesRemove(
  entries: DisableEntry[],
  entry: DisableEntry,
): DisableEntry[] {
  return entries.filter(
    (e) => !(e.name === entry.name && e.level === entry.level),
  );
}
