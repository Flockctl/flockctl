import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Keep this in sync with src/lib/slugify.ts on the server. Kebab-case lowercase
// so the UI placeholder matches the server-generated slug exactly.
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

/**
 * Normalise a server-provided timestamp into something `new Date()` parses
 * as UTC. The daemon mixes two formats:
 *
 *   - ISO with `Z` (e.g. `"2026-04-27T18:17:11.497Z"`) — emitted by JS
 *     code paths via `new Date().toISOString()`. JS parses this as UTC.
 *   - Bare SQLite timestamps (e.g. `"2026-04-27 17:04:51"`) — emitted by
 *     `CURRENT_TIMESTAMP` columns. JS parses this as **local time**, which
 *     gives a wrong "ago" value off by the user's timezone offset. The
 *     stored value is actually UTC, so we append `Z` to force that.
 *
 * Centralising the parse here keeps every call site consistent (chat list
 * row, conversation header, todo timeline, formatters in `format.ts`, etc.)
 * and is the SOLE entry point for turning a server timestamp string into a
 * `Date`. Calling `new Date(serverString).toLocaleString()` directly is a
 * timezone bug — bare SQLite timestamps drift by the user's UTC offset.
 */
export function parseServerTimestamp(input: string): Date {
  // Already has explicit timezone (Z or ±HH:MM) — JS handles correctly.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(input)) {
    return new Date(input);
  }
  // Naïve "YYYY-MM-DD HH:MM:SS" → treat as UTC. Replace the space with `T`
  // and append `Z` so JS uses Date.UTC semantics.
  const iso = input.includes("T") ? input : input.replace(" ", "T");
  return new Date(`${iso}Z`);
}

export function timeAgo(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  const parsed = parseServerTimestamp(dateString);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return "—";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
