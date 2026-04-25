import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed selection state for the project-detail mission-control layout.
 * Mirrors the shape of `useViewMode` (slice 00 task 00): URL is the single
 * source of truth, setters are referentially stable so callers can drop them
 * straight into `useEffect` dep arrays.
 *
 *   ?milestone=<slug>&slice=<slug>
 *
 * Validation contract (security-critical — see
 * `selection_url_params_reject_non_slug_format`):
 *
 *   - The slug regex is the ONLY validation layer. Consumers may render the
 *     returned id directly into the DOM, so anything that does not match must
 *     come back as `null` instead of being passed through.
 *   - Allowed shape: `^[a-z0-9][a-z0-9-]{0,63}$`
 *       · 1–64 chars
 *       · lowercase alnum + hyphen
 *       · must not start with a hyphen
 *   - Empty string  → null  (treated as absent)
 *   - >64 chars     → null  (DoS / log-spam guard)
 *   - Anything with `<`, `>`, quotes, spaces, unicode, uppercase, …  → null
 *
 * When a setter is called and the URL currently holds an invalid value, the
 * setter overwrites that param (or removes it when called with `null`), so the
 * garbage gets stripped on the next user interaction.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MILESTONE_PARAM = "milestone";
export const SLICE_PARAM = "slice";

function validSlug(value: string | null): string | null {
  if (value === null) return null;
  if (value.length === 0) return null;
  return SLUG_RE.test(value) ? value : null;
}

export interface SelectionState {
  milestoneId: string | null;
  sliceId: string | null;
  setMilestone: (id: string | null) => void;
  setSlice: (id: string | null) => void;
  /**
   * Write both params in a single history transition. Needed because
   * calling `setMilestone` followed by `setSlice` in the same React tick
   * loses the first update — `react-router`'s `setSearchParams` reads
   * `prev` from committed state, not from the pending update queue, so
   * the second call clobbers the first.
   */
  setSelection: (next: {
    milestoneId: string | null;
    sliceId: string | null;
  }) => void;
}

export function useSelection(): SelectionState {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawMilestone = searchParams.get(MILESTONE_PARAM);
  const rawSlice = searchParams.get(SLICE_PARAM);

  const milestoneId = useMemo(() => validSlug(rawMilestone), [rawMilestone]);
  const sliceId = useMemo(() => validSlug(rawSlice), [rawSlice]);

  const setParam = useCallback(
    (key: string, next: string | null) => {
      // Pre-validate so a caller passing garbage cannot poison the URL through
      // the setter back-door — same threat model as the read path.
      const sanitized = next === null ? null : validSlug(next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (sanitized === null) {
            params.delete(key);
          } else {
            params.set(key, sanitized);
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setMilestone = useCallback(
    (id: string | null) => setParam(MILESTONE_PARAM, id),
    [setParam],
  );
  const setSlice = useCallback(
    (id: string | null) => setParam(SLICE_PARAM, id),
    [setParam],
  );

  const setSelection = useCallback(
    (next: { milestoneId: string | null; sliceId: string | null }) => {
      const nextMs = next.milestoneId === null ? null : validSlug(next.milestoneId);
      const nextSl = next.sliceId === null ? null : validSlug(next.sliceId);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (nextMs === null) params.delete(MILESTONE_PARAM);
          else params.set(MILESTONE_PARAM, nextMs);
          if (nextSl === null) params.delete(SLICE_PARAM);
          else params.set(SLICE_PARAM, nextSl);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { milestoneId, sliceId, setMilestone, setSlice, setSelection };
}
