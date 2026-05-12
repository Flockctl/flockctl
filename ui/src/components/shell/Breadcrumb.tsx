import * as React from "react";
import { Link, useMatches } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/** Maximum visual length for a single segment label before we truncate. */
const SEGMENT_MAX_CHARS = 32;

/**
 * Truncate a label for display. We hard-cut at `SEGMENT_MAX_CHARS - 1` and
 * append a single ellipsis (`…`), so the total displayed string is exactly
 * `SEGMENT_MAX_CHARS` glyphs. The full label is preserved on the wrapping
 * element via `title=`.
 */
function truncateLabel(label: string): { display: string; truncated: boolean } {
  if (label.length <= SEGMENT_MAX_CHARS) return { display: label, truncated: false };
  return { display: `${label.slice(0, SEGMENT_MAX_CHARS - 1)}…`, truncated: true };
}

/**
 * Prototype's chevron separator (15×15 stroke-1.8). Inline SVG matches
 * `.flockctl/plan/ui-prototype.html` so the breadcrumb visually aligns
 * with the rest of the redesigned shell. Uses `text-zinc-400` per spec.
 */
function BreadcrumbSeparator() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-zinc-400"
      data-testid="breadcrumb-separator"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/**
 * Breadcrumb — derives its segments from `react-router-dom`'s
 * `useMatches()`, calling each route's optional `handle.breadcrumb`
 * factory with the matched route's `params`. A handle may return
 * either:
 *   - `{ label: string; href?: string }` — single segment, OR
 *   - an array of those — for routes that contribute multiple segments
 *     (e.g. project-detail wants `Projects / my-app`).
 *
 * If a handle returns `undefined`/`null`, that match contributes no
 * segments — fine for anonymous wrapper routes that don't earn a
 * place in the trail.
 *
 * Async resolution (slice 03) is owned by the route handles
 * themselves: they may consume route params and React-Query cached
 * data via the `data` argument (we forward `match.data` as a generic
 * pass-through). When data isn't ready yet a handle should return a
 * skeleton segment with `loading: true`; the renderer below shows a
 * pulsing placeholder until the next render flips it to a real label.
 *
 * The component is intentionally read-only and zero-dep: no Zustand,
 * no fetching here. All behaviour is concentrated in route `handle`s.
 */

export type BreadcrumbSegment = {
  /** Display text. Empty string allowed but yields a skeleton placeholder. */
  label: string;
  /** Optional click target; segments without `href` render as plain text. */
  href?: string;
  /** Render as a skeleton until data arrives. */
  loading?: boolean;
};

export type BreadcrumbHandleFn = (args: {
  params: Record<string, string | undefined>;
  data: unknown;
  /**
   * The active QueryClient. Parametric handles use it to look up
   * cached entity names without firing a new request — e.g.
   * `qc.getQueryData(["projects", id])?.name`. The handle is
   * synchronous: if the cache miss, return a `loading: true`
   * placeholder and let the next render (when the data arrives) fill
   * it in.
   */
  qc: QueryClient;
}) => BreadcrumbSegment | BreadcrumbSegment[] | null | undefined;

type RouteHandleWithBreadcrumb = {
  breadcrumb?: BreadcrumbHandleFn;
};

/**
 * Walks `useMatches()` in order, invokes each `handle.breadcrumb`
 * (when present), and flattens the resulting segments. We deliberately
 * do not de-duplicate by `href` — a route is free to re-emit the same
 * label as a parent if that produces a clearer trail.
 */
export function Breadcrumb({ className }: { className?: string } = {}) {
  const matches = useMatches();
  const qc = useQueryClient();
  const segments: BreadcrumbSegment[] = [];

  for (const m of matches) {
    const handle = m.handle as RouteHandleWithBreadcrumb | undefined;
    const fn = handle?.breadcrumb;
    if (typeof fn !== "function") continue;
    let out: BreadcrumbSegment | BreadcrumbSegment[] | null | undefined;
    try {
      out = fn({
        params: (m.params ?? {}) as Record<string, string | undefined>,
        data: m.data,
        qc,
      });
    } catch {
      // A buggy handle MUST NOT crash the chrome — silently drop its
      // contribution and continue the chain. Surfacing the error to
      // the user via a red breadcrumb segment was considered but
      // would just be noise that masks the real upstream issue
      // (pages still render; only the trail is off).
      out = null;
    }
    if (!out) continue;
    if (Array.isArray(out)) segments.push(...out);
    else segments.push(out);
  }

  if (segments.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex min-w-0 items-center gap-1.5 text-[12.5px] ${className ?? ""}`}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const sep = i > 0 ? <BreadcrumbSeparator /> : null;
        const { display } = truncateLabel(seg.label);
        // Always carry the full label on the `title` attribute, so
        // screen readers + tooltips can recover the full text whenever
        // we hard-truncate; on short labels it's a harmless no-op
        // hover-reveal that costs nothing and keeps behaviour uniform.
        const titleAttr = seg.label;
        const body = seg.loading ? (
          <span
            aria-label="loading"
            className="inline-block h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700"
          />
        ) : (
          <span
            className={
              isLast
                ? "font-medium text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500"
            }
            title={titleAttr}
          >
            {display}
          </span>
        );
        const node =
          seg.href && !seg.loading && !isLast ? (
            <Link
              to={seg.href}
              className="text-zinc-500 hover:text-zinc-900 hover:underline focus-visible:underline focus-visible:outline-none dark:hover:text-zinc-100"
              title={titleAttr}
            >
              {display}
            </Link>
          ) : (
            body
          );
        return (
          <React.Fragment key={`${i}-${seg.href ?? seg.label}`}>
            {sep}
            {node}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default Breadcrumb;
