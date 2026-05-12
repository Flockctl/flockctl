import { useQuery } from "@tanstack/react-query";
import { fetchGitShow } from "../api/git-show";
import type { GitShowSuccess } from "../types";

/**
 * git-show single-query hook.
 *
 * Wraps `GET /:scope/:id/git-show?sha=<sha>` in `useQuery` so the
 * commit-detail tab can fetch one commit's metadata + file list on
 * mount and key the resulting cache by `(scope, entityId, sha)`. SHAs
 * are immutable, so the cache entry is permanent for the session —
 * `staleTime: Infinity` keeps re-mounts free.
 *
 * The query throws on a structured failure (`ok: false`) so callers
 * surface the error via `query.error` — same pattern `useGitLog` uses.
 *
 * Disabled when `entityId` or `sha` is empty so the parent can flip
 * targets without juggling conditional rendering.
 */
export function gitShowQueryKey(
  scope: "projects" | "workspaces",
  entityId: string,
  sha: string,
) {
  return [scope, entityId, "git-show", sha] as const;
}

export function useGitShow(
  scope: "projects" | "workspaces",
  entityId: string,
  sha: string,
) {
  return useQuery<GitShowSuccess, Error>({
    queryKey: gitShowQueryKey(scope, entityId, sha),
    queryFn: async () => {
      const result = await fetchGitShow(scope, entityId, sha);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        const detail = result.message ? ` (${result.message})` : "";
        const err = new Error(`git-show failed: ${reason}${detail}`);
        (err as Error & { reason?: string }).reason = reason;
        throw err;
      }
      return result;
    },
    enabled: !!entityId && !!sha,
    staleTime: Infinity,
  });
}
