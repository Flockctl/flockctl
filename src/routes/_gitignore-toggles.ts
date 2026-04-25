import { ValidationError } from "../lib/errors.js";

/**
 * Shared parser for the three gitignore toggles on projects and workspaces:
 *   - `gitignoreFlockctl`  → ignore the whole `.flockctl/` dir
 *   - `gitignoreTodo`      → ignore root `TODO.md`
 *   - `gitignoreAgentsMd`  → ignore root `AGENTS.md` and `CLAUDE.md` (paired)
 *
 * Rules:
 *   1. Values must be booleans when provided — strings / numbers / null are
 *      rejected so the API surface stays narrow and typos surface as 400s
 *      instead of silently coercing to `false`.
 *   2. Omitted fields are excluded from the result (undefined ≠ false) so
 *      PATCH can update a subset without clobbering unlisted flags.
 *   3. On POST the caller defaults `undefined` to `false` via `?? false`
 *      at the drizzle insert site — this helper never invents defaults
 *      so POST and PATCH stay symmetric.
 */
export interface GitignoreTogglePatch {
  gitignoreFlockctl?: boolean;
  gitignoreTodo?: boolean;
  gitignoreAgentsMd?: boolean;
}

const FIELDS: Array<keyof GitignoreTogglePatch> = [
  "gitignoreFlockctl",
  "gitignoreTodo",
  "gitignoreAgentsMd",
];

export function parseGitignoreToggles(body: Record<string, unknown>): GitignoreTogglePatch {
  const out: GitignoreTogglePatch = {};
  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    if (typeof raw !== "boolean") {
      throw new ValidationError(`${key} must be boolean`);
    }
    out[key] = raw;
  }
  return out;
}

/** True when at least one toggle was supplied in the request body. */
export function hasGitignoreToggles(patch: GitignoreTogglePatch): boolean {
  return FIELDS.some((k) => patch[k] !== undefined);
}
