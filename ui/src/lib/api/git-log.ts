import type { GitLogResult } from "../types";
import { apiFetch } from "./core";

/**
 * git-log API client — paginated commit-history walk for a project or
 * workspace. Backed by `GET /:scope/:id/git-log` (the project + workspace
 * routers share the `makeGitRouteHandlers` factory; the response shape
 * is identical on both surfaces).
 *
 * Pagination model: cursor-based. The server walks `git log` from `HEAD`
 * (or `branch` if supplied) and returns at most `limit` commits plus a
 * `next_cursor` SHA — non-null while more history is available, `null`
 * once the walk has reached the root commit. Pass `cursor` on the next
 * call to continue from there.
 *
 * Always resolves with HTTP 200 on the wire — outcome (success /
 * structured failure) is encoded in the body's discriminated `ok`
 * field. The hook layer (`useGitLogProject` / `useGitLogWorkspace`)
 * surfaces failure via `query.error` by throwing on `ok: false`, which
 * keeps the page-level reducer trivial.
 *
 * @param scope        `"projects"` or `"workspaces"` — the entity surface.
 * @param entityId     Numeric id of the project or workspace.
 * @param params       Optional pagination params.
 * @param params.limit Page size. Server clamps to `[1, 100]`; default 30.
 *                     We don't enforce here — the server is the source of
 *                     truth on bounds.
 * @param params.cursor Hex SHA from a previous response's `next_cursor`.
 *                      Mutually exclusive with `branch` server-side: when
 *                      both are supplied, `cursor` wins.
 * @param params.branch Optional branch / ref to walk from. Server validates
 *                      against a conservative ref-name grammar.
 */
export interface FetchGitLogParams {
  limit?: number;
  cursor?: string;
  branch?: string;
}

export function fetchGitLog(
  scope: "projects" | "workspaces",
  entityId: string,
  params: FetchGitLogParams = {},
): Promise<GitLogResult> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.branch) qs.set("branch", params.branch);
  const suffix = qs.toString();
  return apiFetch<GitLogResult>(
    `/${scope}/${entityId}/git-log${suffix ? `?${suffix}` : ""}`,
  );
}
