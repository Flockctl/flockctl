/**
 * Ambient type declarations for the (un-typed) `fzy.js` package — the
 * canonical JS port of John Hawthorn's `fzy` fuzzy-matcher. Used by the
 * Quick-Open modal to score project paths against the operator's
 * query. Keep this in sync with `node_modules/fzy.js/index.js`.
 */
declare module "fzy.js" {
  /**
   * Score `haystack` against `needle`. Higher is better; returns
   * `SCORE_MIN` (`-Infinity`) when there is no match. Note the argument
   * order — needle FIRST (mirrors C `fzy`), unlike `String#includes`.
   */
  export function score(needle: string, haystack: string): number;

  /** Return the positions in `haystack` that matched `needle`, or `null`. */
  export function positions(needle: string, haystack: string): number[] | null;

  /** Predicate: does `needle` fuzzy-match `haystack` at all? */
  export function hasMatch(needle: string, haystack: string): boolean;

  export const SCORE_MIN: number;
  export const SCORE_MAX: number;
}
