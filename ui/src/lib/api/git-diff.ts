/**
 * git-diff API client (contents-aware).
 *
 * Wraps `GET /:scope/:id/git-diff?path=<rel>&staged=…&base=…&head=…&contents=…`
 * for the Code-mode diff tab. The commit-detail tab keeps using the
 * leaner `fetchGitDiff` in `./git-show.ts` (no `contents` param) so an
 * incidental refactor of the diff-tab payload doesn't perturb its
 * cache shape.
 *
 * Wire contract mirrors the rest of the git surface: HTTP 200 with a
 * discriminated body. Outcome is encoded in `ok` / `reason` — callers
 * branch on the body, never on a thrown HTTP error.
 *
 * The `contents` opt-in is what augments the response with the two full
 * text buffers Monaco's DiffEditor needs (`original_content` /
 * `modified_content`). Each side is capped at 2.5 MiB by the server;
 * a side that exceeds the cap comes back as `null` while the patch +
 * status fields stay populated. Callers render a fallback in that case.
 */
import type { GitDiffResult as GitDiffShowResult } from "./git-show";
import { apiFetch } from "./core";

/**
 * Diff-side selector. Mutually exclusive — passing `staged: true` with
 * `base`/`head` is rejected upstream as `bad_revision`. The default
 * (no fields) is "working tree vs index".
 */
export interface GitDiffMode {
  staged?: boolean;
  base?: string;
  head?: string;
}

/**
 * Full success response when `contents=true` is set. Extends the
 * commit-detail-tab's `GitDiffSuccess` (in `./git-show.ts`) with the
 * two side buffers — keeping the discriminated `ok` field shape so
 * existing consumers can narrow on it.
 */
export type GitDiffWithContentsSuccess = Extract<
  GitDiffShowResult,
  { ok: true }
> & {
  /**
   * Source-side blob. `null` when:
   *   - status is `binary` (Monaco can't render binary diffs);
   *   - file did not exist on the source side (status `'A'`);
   *   - blob exceeded the 2.5 MiB per-side cap;
   *   - read failed for any other reason.
   * Always present (possibly null) when `contents=true` was requested.
   */
  original_content: string | null;
  /** Target-side blob — same null semantics as `original_content`. */
  modified_content: string | null;
};

export type GitDiffWithContentsResult =
  | GitDiffWithContentsSuccess
  | Extract<GitDiffShowResult, { ok: false }>;

/**
 * Fetch the per-file diff with both side buffers populated. Always
 * passes `contents=true` so the response includes
 * `original_content` / `modified_content` for Monaco's DiffEditor.
 *
 * The response is HTTP-200 even on structured failure (`ok: false` with
 * a `reason`); callers branch on `result.ok` rather than catching
 * exceptions. A 422 (malformed query) surfaces as a thrown Error from
 * {@link apiFetch}.
 */
export function fetchGitDiffWithContents(
  scope: "projects" | "workspaces",
  entityId: string,
  params: { path: string } & GitDiffMode,
): Promise<GitDiffWithContentsResult> {
  const qs = new URLSearchParams({
    path: params.path,
    contents: "true",
  });
  if (params.staged === true) qs.set("staged", "true");
  if (params.base !== undefined) qs.set("base", params.base);
  if (params.head !== undefined) qs.set("head", params.head);
  return apiFetch<GitDiffWithContentsResult>(
    `/${scope}/${entityId}/git-diff?${qs.toString()}`,
  );
}
