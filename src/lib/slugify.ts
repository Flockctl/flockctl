/**
 * Convert a human-readable name to a filesystem-safe slug.
 *
 * Output is lowercase kebab-case so slugs are consistent with what the plan
 * generator emits and what the UI router expects. Spaces and underscores both
 * collapse to single dashes; non-alphanumeric/dash/dot characters are dropped;
 * leading/trailing dashes are trimmed; an input that collapses to empty (e.g.
 * `"!@#"` or `"   "`) falls back to `"unnamed"`.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    || "unnamed";
}
