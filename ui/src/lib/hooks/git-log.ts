import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { fetchGitLog, type FetchGitLogParams } from "../api/git-log";
import type { GitLogPage } from "../types";

/**
 * git-log infinite-query hook.
 *
 * Wraps `GET /:scope/:id/git-log` in `useInfiniteQuery` so the History
 * list inside the SCM panel can paginate forward without the parent
 * having to maintain a manual accumulator. The page param is the
 * cursor SHA returned by the previous response; `undefined` for the
 * first page (server walks from `HEAD`).
 *
 * The query throws on a structured failure (`ok: false`) so callers
 * surface the error via `query.error` — the alternative would force
 * each consumer to introspect every page for `ok` discriminator,
 * and there is no mode in which a successful pagination cycle yields
 * a mix of successful + failed pages.
 *
 * `staleTime: 0` is intentional: history is shaped by every commit /
 * push / pull, and the SCM panel has no live invalidation pipeline
 * (the FS watcher M04 brings in fires on file changes, not ref
 * updates). Refetch on remount is the correct trade-off until that
 * pipe exists.
 *
 * Disabled when `entityId` is empty — same gating pattern the rest of
 * the git hooks use so the parent can flip targets without juggling
 * conditional rendering.
 */
export function gitLogQueryKey(
  scope: "projects" | "workspaces",
  entityId: string,
  branch?: string,
) {
  return [scope, entityId, "git-log", branch ?? null] as const;
}

export interface UseGitLogOptions extends Omit<FetchGitLogParams, "cursor"> {
  enabled?: boolean;
}

export function useGitLog(
  scope: "projects" | "workspaces",
  entityId: string,
  options: UseGitLogOptions = {},
) {
  const { enabled = true, limit, branch } = options;
  return useInfiniteQuery<
    GitLogPage,
    Error,
    InfiniteData<GitLogPage, string | undefined>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: gitLogQueryKey(scope, entityId, branch),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const result = await fetchGitLog(scope, entityId, {
        limit,
        cursor: pageParam,
        branch,
      });
      if (!result.ok) {
        // Surface the server-side reason in the thrown error so the UI
        // can disambiguate `not_a_repo` ("Not a git repository.") from
        // generic failures without a separate query handle.
        const reason = result.reason ?? "unknown";
        const detail = result.message ? ` (${result.message})` : "";
        const err = new Error(`git-log failed: ${reason}${detail}`);
        // Stash the structured reason so the renderer can key copy off
        // it. `Error.cause` is the standard escape hatch and lands in
        // both modern browsers and the test environment.
        (err as Error & { reason?: string }).reason = reason;
        throw err;
      }
      return { commits: result.commits, next_cursor: result.next_cursor };
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: enabled && !!entityId,
    staleTime: 0,
  });
}
