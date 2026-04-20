/**
 * Convert a human-readable name to a filesystem-safe directory name.
 * Replaces spaces with underscores, removes unsafe characters,
 * and collapses consecutive underscores.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-\.]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_\-]+|[_\-]+$/g, "")
    || "unnamed";
}
