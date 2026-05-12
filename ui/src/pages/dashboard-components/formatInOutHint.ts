/**
 * Render the in/out token ratio as a compact hint string for the
 * dashboard's Tokens KPI tile.
 *
 * Behaviour:
 *   - `(undefined, undefined)`        → undefined
 *   - `(0, 0)`                        → undefined  (avoid `0:0` noise)
 *   - `(N>0, 0)`                      → "in only"
 *   - `(in, out)`                     → "in/out R:1" where R = round(in/out, 1)
 *
 * The :1 suffix is fixed by the brief; the numerator is rounded to one
 * decimal so a 3.05:1 ratio doesn't render identical to 3:1. Integer
 * results drop the trailing `.0` (so 3.0:1 → 3:1) but non-integers keep
 * one decimal (1.5:1).
 */
export function formatInOutHint(
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): string | undefined {
  if (tokensIn === undefined || tokensOut === undefined) return undefined;
  if (tokensIn === 0 && tokensOut === 0) return undefined;
  if (tokensOut === 0) return "in only";
  const ratio = tokensIn / tokensOut;
  const rounded = Math.round(ratio * 10) / 10;
  const printed = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(1);
  return `in/out ${printed}:1`;
}
