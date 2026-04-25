/**
 * Shared helpers for CLI commands that talk to the daemon.
 *
 * Keeps resolver + formatter logic in one place so the `project` and
 * `workspace` command modules stay focused on argument parsing and the call
 * they delegate to. Everything here assumes the daemon is reachable; callers
 * should wrap their actions in `exitWithDaemonError`.
 */
import { DaemonClient } from "../lib/daemon-client.js";

export interface NamedRow {
  id: number;
  name: string;
  path?: string | null;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Accept either a numeric id ("12") or a human name ("my-project") and return
 * the matching row. Name matching is case-insensitive and unique — if two
 * rows share a name we throw so the caller can fall back to id.
 *
 * We list with a large perPage (500) to avoid pagination round-trips; most
 * installs have a handful of projects/workspaces.
 */
export async function resolveByIdOrName<T extends NamedRow>(
  client: DaemonClient,
  collection: "projects" | "workspaces",
  ref: string,
): Promise<T> {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    return await client.get<T>(`/${collection}/${trimmed}`);
  }

  const res = await client.get<ListResponse<T>>(`/${collection}`, { perPage: 500 });
  const target = trimmed.toLowerCase();
  const matches = res.items.filter((row) => row.name.toLowerCase() === target);
  if (matches.length === 0) {
    throw new Error(`No ${singular(collection)} found with name "${trimmed}"`);
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    throw new Error(
      `Multiple ${collection} named "${trimmed}" exist (ids: ${ids}). Pass the id instead.`,
    );
  }
  // Re-fetch the single item so the caller gets the detail payload (with
  // milestones / child projects / …), not just the list projection.
  const only = matches[0]!;
  return await client.get<T>(`/${collection}/${only.id}`);
}

function singular(c: "projects" | "workspaces"): string {
  return c === "projects" ? "project" : "workspace";
}

/**
 * Print a two-column id/name/path table to stdout. Kept deliberately simple —
 * we pad with spaces rather than pulling in a table-rendering dep.
 */
export function printRowTable(rows: NamedRow[], extra?: (row: NamedRow) => string): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const idWidth = Math.max(2, ...rows.map((r) => String(r.id).length));
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const header =
    `${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}  ` +
    (extra ? "EXTRA  " : "") +
    "PATH";
  console.log(header);
  for (const r of rows) {
    const parts = [
      String(r.id).padEnd(idWidth),
      r.name.padEnd(nameWidth),
    ];
    if (extra) parts.push(extra(r).padEnd(5));
    parts.push(r.path ?? "");
    console.log(parts.join("  "));
  }
}

/**
 * Pretty-print a JSON payload. `--json` flags on show / scan / dashboard
 * commands short-circuit to `JSON.stringify(..., 2)`; anything else uses this
 * as the default human-readable fallback.
 */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
