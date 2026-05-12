import { apiFetch } from "./core";

/**
 * git-branches API client — list / checkout / delete a local or remote
 * branch on a project or workspace clone. Backed by:
 *
 *   - `GET    /:scope/:id/git-branches`             → list
 *   - `POST   /:scope/:id/git-checkout`             → switch / create
 *   - `DELETE /:scope/:id/git-branches/:name`       → delete
 *
 * The project + workspace routers share the `makeGitRouteHandlers`
 * factory, so the wire shape is identical on both surfaces.
 *
 * Wire contract mirrors the rest of the git surface:
 *   - HTTP 200 always, even on structured failure. Outcome is encoded in
 *     the discriminated `ok` field; callers branch on `result.ok` rather
 *     than catching exceptions.
 *   - 422 is reserved for malformed bodies / branch names; those surface
 *     as a thrown Error from {@link apiFetch}.
 *   - Response keys arrive snake_cased after `toSnakeKeys` runs in
 *     `apiFetch`, so the server-side `isRemote` lands here as
 *     `is_remote`. The types below match the on-the-wire shape after
 *     conversion.
 */

// --- List ------------------------------------------------------------------

export type GitBranchListReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitBranchEntry {
  name: string;
  /** True for the branch HEAD currently points at. */
  current: boolean;
  /** Tracking branch (e.g. `origin/main`) or `null` when none is configured. */
  upstream: string | null;
  /** Commits the local branch is ahead of upstream by; 0 when no upstream. */
  ahead: number;
  /** Commits behind upstream; 0 when no upstream. */
  behind: number;
  /** True for refs under `refs/remotes/`. */
  is_remote: boolean;
}

export interface GitBranchListSuccess {
  ok: true;
  branches: GitBranchEntry[];
  /** True when HEAD is detached (no `*` row in the local-branch slice). */
  detached: boolean;
  reason?: "ok";
}

export interface GitBranchListFailure {
  ok: false;
  reason: GitBranchListReason;
  message?: string;
  stderr?: string;
}

export type GitBranchListResult = GitBranchListSuccess | GitBranchListFailure;

export function fetchGitBranches(
  scope: "projects" | "workspaces",
  entityId: string,
): Promise<GitBranchListResult> {
  return apiFetch<GitBranchListResult>(`/${scope}/${entityId}/git-branches`);
}

// --- Checkout --------------------------------------------------------------

export type GitCheckoutReason =
  | "ok"
  | "dirty_working_tree"
  | "branch_not_found"
  | "branch_already_exists"
  | "invalid_branch_name"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitCheckoutSuccess {
  ok: true;
  branch: string;
  /** True when the operation created a new branch (`create=true`). */
  created: boolean;
  reason?: "ok";
}

export interface GitCheckoutFailure {
  ok: false;
  branch?: string;
  reason: GitCheckoutReason;
  message?: string;
  stderr?: string;
}

export type GitCheckoutResult = GitCheckoutSuccess | GitCheckoutFailure;

export interface GitCheckoutBody {
  branch: string;
  /** When true, run `git checkout -b <branch> [<startPoint>]`. */
  create?: boolean;
  /** Optional starting ref for `-b`. Ignored when `create` is false. */
  startPoint?: string;
}

export function gitCheckout(
  scope: "projects" | "workspaces",
  entityId: string,
  body: GitCheckoutBody,
): Promise<GitCheckoutResult> {
  return apiFetch<GitCheckoutResult>(`/${scope}/${entityId}/git-checkout`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Delete ----------------------------------------------------------------

export type GitBranchDeleteReason =
  | "ok"
  | "git_protected_branch"
  | "git_cannot_delete_current_branch"
  | "branch_not_found"
  | "not_fully_merged"
  | "invalid_branch_name"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitBranchDeleteSuccess {
  ok: true;
  branch: string;
  reason?: "ok";
}

export interface GitBranchDeleteFailure {
  ok: false;
  branch?: string;
  reason: GitBranchDeleteReason;
  message?: string;
  stderr?: string;
}

export type GitBranchDeleteResult =
  | GitBranchDeleteSuccess
  | GitBranchDeleteFailure;

export interface GitBranchDeleteBody {
  /** When true, use `git branch -D` (force-delete unmerged branches). */
  force?: boolean;
}

export function gitBranchDelete(
  scope: "projects" | "workspaces",
  entityId: string,
  branch: string,
  body: GitBranchDeleteBody = {},
): Promise<GitBranchDeleteResult> {
  // Branch names can contain `/` (e.g. `feature/foo`). The route param is
  // `:name{.+}` (Hono wildcard) so we must encode each segment but keep
  // the slashes intact. `encodeURIComponent` would escape `/` to `%2F`,
  // which Hono decodes back to `/` before reaching the regex — fine, but
  // we use a `split / encode / join` pass so the URL stays human-readable
  // in the network panel for the common no-slash case.
  const encoded = branch
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return apiFetch<GitBranchDeleteResult>(
    `/${scope}/${entityId}/git-branches/${encoded}`,
    {
      method: "DELETE",
      body: JSON.stringify(body),
    },
  );
}

/**
 * Branches that the backend refuses to delete unless `force=true` is set.
 * Mirrors `PROTECTED_DELETE_BRANCHES` in `src/services/git-operations.ts`.
 * Surfaced here so the UI can pre-render the "Force delete" guard before
 * the user clicks Delete.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Public branch-name regex pinned in the slice spec. Mirrors the server's
 * `BRANCH_NAME` zod schema in `src/routes/git-route-handlers.ts`. We
 * pre-validate in the UI so the Create dialog can disable Submit before
 * a 422 round-trip.
 */
export const BRANCH_NAME_RE = /^[\w\-./а-яА-ЯёЁ]+$/u;
