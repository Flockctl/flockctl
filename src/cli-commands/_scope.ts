/**
 * Shared scope-resolution helpers for commands that follow the
 * global / workspace / project triple — `mcp`, `skills`, `templates`,
 * (and `secrets`, which uses its own version because the API path
 * shape differs slightly).
 *
 * The convention everywhere:
 *   --workspace <idOrName>  → workspace scope
 *   --project   <idOrName>  → project scope
 *   neither                 → global scope
 *   both                    → error
 */
import { resolveByIdOrName, type NamedRow } from "./_shared.js";
import type { DaemonClient } from "../lib/daemon-client.js";

export type Scope = "global" | "workspace" | "project";

export interface ScopeOpts {
  workspace?: string;
  project?: string;
}

export function pickScope(opts: ScopeOpts): Scope {
  if (opts.workspace && opts.project) {
    throw new Error("Pass at most one of --workspace / --project (or neither for global).");
  }
  if (opts.workspace) return "workspace";
  if (opts.project) return "project";
  return "global";
}

export async function resolveScopeId(
  client: DaemonClient,
  scope: Scope,
  opts: ScopeOpts,
): Promise<number | null> {
  if (scope === "global") return null;
  const ref = scope === "workspace" ? opts.workspace : opts.project;
  if (!ref) {
    throw new Error(`--${scope} <idOrName> is required for ${scope} scope`);
  }
  const collection = scope === "workspace" ? "workspaces" : "projects";
  const row = await resolveByIdOrName<NamedRow>(client, collection, ref);
  return row.id;
}

/**
 * Build the conventional `/<resource>/<bucket>` path. `bucket` is one of:
 *   - `global`            (scopeId always null)
 *   - `workspaces/:id`
 *   - `projects/:id`
 *
 * `resource` is the route prefix without leading slash, e.g. "mcp", "skills",
 * "secrets". The function never appends a trailing path component — callers
 * tack on `/${name}` themselves where needed.
 */
export function scopeBucketPath(
  resource: string,
  scope: Scope,
  scopeId: number | null,
): string {
  if (scope === "global") return `/${resource}/global`;
  if (scope === "workspace") return `/${resource}/workspaces/${scopeId}`;
  return `/${resource}/projects/${scopeId}`;
}
