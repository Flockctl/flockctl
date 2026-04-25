/**
 * Shared display formatters. Replaces ~14 scattered local helpers across pages
 * (`formatTime`, `formatTokens`, `fmtTokens`, `fmtDuration`, etc.).
 *
 * Keep the API stable: existing pages import by name and rely on the exact
 * output — "1.2K", "5m 3s", "$0.42" — so changes here are user-visible.
 */

/** `new Date(iso).toLocaleString()` or `-` for null/undefined. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

/** Assumes non-null; thin wrapper over `toLocaleString()`. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** `HH:MM:SS` 24h; use for log timestamps. */
export function formatLogTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
}

/** Compact token count: 12345 → "12.3K", 1234567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Precise seconds-duration: `42s`, `5m 3s`, `1h 30m`. Use when a rough "minutes
 * ago" reading would lose useful info (task timing, chat latency).
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Coarse seconds-duration: `42s`, `5m`, `1h 30m`. Use for high-level analytics
 * summaries where sub-minute precision is noise.
 */
export function formatDurationCoarse(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** `0.125` → `"12.5%"`, `null` → `"N/A"`. */
export function formatPercent(rate: number | null): string {
  if (rate === null) return "N/A";
  return `${(rate * 100).toFixed(1)}%`;
}

/** `0.4239` → `"$0.42"`. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
