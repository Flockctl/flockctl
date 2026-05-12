import { ValidationError } from "../lib/errors.js";

/**
 * Allowed values for `tasks.isolation` / `chats.isolation`.
 *
 * Kept stringly-typed (rather than a TS enum) because the column itself
 * is `TEXT NULL` — adding a new mode (`'container'`, `'sandbox'`, …)
 * stays a code-only change with no migration required. The runtime
 * Set is the single source of truth at the API boundary.
 */
const ISOLATION_VALUES = new Set(["worktree"] as const);
export type IsolationMode = "worktree";

/**
 * Parse and validate `isolation` from a POST/PATCH body. Mirrors the
 * `parsePermissionModeBody` contract:
 *
 *   - returns `undefined` when the key is absent (caller skips the
 *     column on insert/update)
 *   - returns `null` when the key is present and the value is null
 *     (caller writes NULL — opt out of isolation)
 *   - returns the validated string when a known mode is supplied
 *   - throws ValidationError on an unknown mode
 *
 * Both snake_case (`isolation`) and the camelCase fallback are
 * accepted; only one shape is needed because the column name itself
 * has no underscores, but we keep the dispatch-on-presence pattern
 * for symmetry with `_permission-mode.ts`.
 */
export function parseIsolationBody(
  body: Record<string, unknown>,
): IsolationMode | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "isolation")) return undefined;
  const raw = (body as { isolation: unknown }).isolation;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ValidationError(
      `isolation must be a string or null, got ${typeof raw}`,
    );
  }
  if (!ISOLATION_VALUES.has(raw as IsolationMode)) {
    throw new ValidationError(
      `unknown isolation mode '${raw}' — allowed: ${Array.from(ISOLATION_VALUES).join(", ")}`,
    );
  }
  return raw as IsolationMode;
}
