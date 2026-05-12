import { apiFetch } from "./core";

/**
 * git-stash API client — push / list / pop / drop on the stash stack for
 * a project or workspace clone. Backed by:
 *
 *   - `POST   /:scope/:id/git-stash-push`  body { message?, includeUntracked? }
 *   - `GET    /:scope/:id/git-stash-list`  no body
 *   - `POST   /:scope/:id/git-stash-pop`   body { ref: 'stash@{N}' }
 *   - `DELETE /:scope/:id/git-stash/:ref`  no body
 *
 * The project + workspace routers share the `makeGitRouteHandlers`
 * factory, so the wire shape is identical on both surfaces.
 *
 * Wire contract mirrors the rest of the git surface:
 *   - HTTP 200 always, even on structured failure. Outcome is encoded in
 *     the discriminated `ok` field; callers branch on `result.ok` rather
 *     than catching exceptions.
 *   - 422 is reserved for malformed bodies / refs; those surface as a
 *     thrown Error from {@link apiFetch}.
 *   - Response keys arrive snake_cased after `toSnakeKeys` runs in
 *     `apiFetch` so `nothingToStash` becomes `nothing_to_stash` here.
 *
 * The "no local changes to save" no-op surfaces as
 * `{ ok: true, nothing_to_stash: true, reason: "nothing_to_stash" }` —
 * callers can render an "already clean" hint without us mis-classifying
 * it as a failure.
 */

// --- Push ------------------------------------------------------------------

export type GitStashPushReason =
  | "ok"
  | "nothing_to_stash"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitStashPushSuccess {
  ok: true;
  /** True when git reported "No local changes to save" — exit 0, no stash created. */
  nothing_to_stash?: boolean;
  reason?: GitStashPushReason;
}

export interface GitStashPushFailure {
  ok: false;
  reason: GitStashPushReason;
  message?: string;
  stderr?: string;
}

export type GitStashPushResult = GitStashPushSuccess | GitStashPushFailure;

export interface GitStashPushBody {
  /** Optional `-m <message>` for the stash entry. ≤ 4096 bytes server-side. */
  message?: string;
  /** Toggle `-u` (include untracked files in the stash). Defaults to false. */
  includeUntracked?: boolean;
}

export function gitStashPush(
  scope: "projects" | "workspaces",
  entityId: string,
  body: GitStashPushBody = {},
): Promise<GitStashPushResult> {
  return apiFetch<GitStashPushResult>(`/${scope}/${entityId}/git-stash-push`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- List ------------------------------------------------------------------

export type GitStashListReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitStashEntry {
  /** `stash@{N}` reflog selector — stable for as long as the entry exists. */
  ref: string;
  /** Commit hash of the stash tip. Used to open a commit-detail tab. */
  hash: string;
  /** ISO-8601 commit date. */
  date: string;
  /** Stash subject — git's `WIP on <branch>: …` or the `-m` body. */
  message: string;
}

export interface GitStashListSuccess {
  ok: true;
  stashes: GitStashEntry[];
  reason?: "ok";
}

export interface GitStashListFailure {
  ok: false;
  reason: GitStashListReason;
  message?: string;
  stderr?: string;
}

export type GitStashListResult = GitStashListSuccess | GitStashListFailure;

export function fetchGitStashList(
  scope: "projects" | "workspaces",
  entityId: string,
): Promise<GitStashListResult> {
  return apiFetch<GitStashListResult>(`/${scope}/${entityId}/git-stash-list`);
}

// --- Pop -------------------------------------------------------------------

export type GitStashPopReason =
  | "ok"
  | "git_stash_pop_conflict"
  | "not_found"
  | "invalid_ref"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitStashPopSuccess {
  ok: true;
  reason?: "ok";
}

export interface GitStashPopFailure {
  ok: false;
  reason: GitStashPopReason;
  message?: string;
  stderr?: string;
}

export type GitStashPopResult = GitStashPopSuccess | GitStashPopFailure;

export interface GitStashPopBody {
  /** Canonical `stash@{N}` reflog selector. */
  ref: string;
}

export function gitStashPop(
  scope: "projects" | "workspaces",
  entityId: string,
  body: GitStashPopBody,
): Promise<GitStashPopResult> {
  return apiFetch<GitStashPopResult>(`/${scope}/${entityId}/git-stash-pop`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Drop ------------------------------------------------------------------

export type GitStashDropReason =
  | "ok"
  | "not_found"
  | "invalid_ref"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitStashDropSuccess {
  ok: true;
  reason?: "ok";
}

export interface GitStashDropFailure {
  ok: false;
  reason: GitStashDropReason;
  message?: string;
  stderr?: string;
}

export type GitStashDropResult = GitStashDropSuccess | GitStashDropFailure;

export function gitStashDrop(
  scope: "projects" | "workspaces",
  entityId: string,
  ref: string,
): Promise<GitStashDropResult> {
  // The route is `/:scope/:id/git-stash/:ref{.+}` — Hono path-decodes the
  // segment, so we percent-encode the `@` and `{` `}` characters via
  // `encodeURIComponent` to keep them intact across the wire boundary.
  const encoded = encodeURIComponent(ref);
  return apiFetch<GitStashDropResult>(
    `/${scope}/${entityId}/git-stash/${encoded}`,
    { method: "DELETE" },
  );
}

/**
 * Canonical `stash@{N}` reflog-selector regex. Mirrors the server's
 * `STASH_REF` zod schema in `src/routes/git-route-handlers.ts`. Surfaced
 * here so the StashPushDialog / StashSection can validate refs locally
 * before issuing a request that would 422.
 */
export const STASH_REF_RE = /^stash@\{\d+\}$/;
