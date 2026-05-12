import { cn } from "@/lib/utils";
import type { GitLogCommit } from "@/lib/types";

/**
 * One row in the SCM panel's History list.
 *
 * Layout (left → right):
 *   abc1234   feat: ship the loop  ─ Eduard ─ 2h ago
 *   |         |                       |        |
 *   |         |                       |        └─ relative author timestamp
 *   |         |                       └─ author name
 *   |         └─ subject (truncated, full text in `title`)
 *   └─ short SHA (monospace, 7 chars)
 *
 * The component is intentionally presentational — it does not own
 * navigation. Click handling is delegated to `onClick` so the parent can
 * route to the commit-detail tab (slice 01 wires that up). When `onClick`
 * is omitted the row renders as a non-interactive `<li>`.
 *
 * Test-id contract:
 *   - `scm-history-row-{sha}`        — `<li>` root.
 *   - `scm-history-sha-{sha}`        — short SHA span.
 *   - `scm-history-subject-{sha}`    — subject span (carries `title` tooltip).
 *   - `scm-history-author-{sha}`     — author span.
 *   - `scm-history-time-{sha}`       — relative-time span (carries an ISO `title`).
 */
export interface CommitRowProps {
  commit: GitLogCommit;
  /**
   * Pre-computed relative time label (e.g. `"2h ago"`). The parent owns
   * the formatter so a single `Date.now()` reading drives every row in
   * the page — keeps the rendering deterministic across virtual rows
   * and re-renders.
   */
  relativeTime: string;
  /** ISO-8601 string of the author timestamp; used as the row's `title`. */
  isoTime: string;
  /**
   * Click handler. Receives the full SHA so the parent can route to
   * `…/git/commit/{sha}` (slice 01). Omit to render the row in a
   * non-interactive read-only mode.
   */
  onClick?: (sha: string) => void;
}

export function CommitRow({
  commit,
  relativeTime,
  isoTime,
  onClick,
}: CommitRowProps) {
  const interactive = !!onClick;
  const handleClick = () => {
    if (onClick) onClick(commit.sha);
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(commit.sha);
    }
  };

  return (
    <li
      data-testid={`scm-history-row-${commit.sha}`}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-xs",
        interactive &&
          "cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none",
      )}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={commit.subject}
    >
      <span
        data-testid={`scm-history-sha-${commit.sha}`}
        className="shrink-0 font-mono text-[11px] text-muted-foreground"
      >
        {commit.short_sha}
      </span>
      <span
        data-testid={`scm-history-subject-${commit.sha}`}
        className="flex-1 truncate"
        title={commit.subject}
      >
        {commit.subject}
      </span>
      <span
        data-testid={`scm-history-author-${commit.sha}`}
        className="shrink-0 truncate text-[11px] text-muted-foreground max-w-[80px]"
        title={`${commit.author} <${commit.email}>`}
      >
        {commit.author}
      </span>
      <span
        data-testid={`scm-history-time-${commit.sha}`}
        className="shrink-0 text-[11px] text-muted-foreground"
        title={isoTime}
      >
        {relativeTime}
      </span>
    </li>
  );
}
