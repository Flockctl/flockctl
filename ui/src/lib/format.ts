/**
 * Shared display formatters. Replaces ~14 scattered local helpers across pages
 * (`formatTime`, `formatTokens`, `fmtTokens`, `fmtDuration`, `formatCost`,
 * `formatCents`, `formatUsd`, etc.).
 *
 * Keep the API stable: existing pages import by name and rely on the exact
 * output — "1.2K", "5m 3s", "$0.42" — so changes here are user-visible.
 *
 * **Timestamp policy.** All timestamp formatters in this file route the input
 * string through {@link parseServerTimestamp} before formatting, so both ISO
 * (`"…Z"`) and bare SQLite (`"YYYY-MM-DD HH:MM:SS"`) shapes coming back from
 * the daemon are interpreted as UTC and rendered in the browser's local TZ.
 * Do NOT call `new Date(serverTimestamp).toLocaleString()` directly — bare
 * SQLite timestamps drift by the user's UTC offset (e.g. UTC+3 in Moscow).
 *
 * **Cost-formatting policy.** Pick the helper that matches the input units:
 *   - `formatCost(usd)` → `$0.42` (USD input, 2 decimals).
 *   - `formatCostPrecise(usd | null)` → `null → "—"`, sub-cent → 4 decimals.
 *   - `formatCostFine(usd)` → always 4 decimals (chart tooltips, fine spend).
 *   - `formatCents(cents | null, opts?)` → cents input. `null` returns the
 *     `nullSentinel` (default `"—"`). When `precise: true`, sub-dollar
 *     amounts get 4 decimals, mirroring `formatCostPrecise`.
 *   - `formatUsdIntl(usd, fractionDigits?)` → `Intl.NumberFormat` USD,
 *     compact-ready. Use for KPI tiles where `Intl`'s grouping helps
 *     readability ("$1,234.56"). Defaults to 2 decimals.
 *
 * Don't introduce a sixth variant. If a new view needs a different shape,
 * extend one of these (with a new opt) and swap call sites in the same PR.
 */

import { parseServerTimestamp } from "./utils";

/** Local-TZ `toLocaleString()` of a server timestamp, or `-` for null/undefined. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = parseServerTimestamp(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

/**
 * @deprecated Use {@link formatTimestamp} — it accepts the same input plus
 * `null`/`undefined` and returns `"-"` for the missing case. The two helpers
 * differ only in null-handling, and we kept this alias for compatibility
 * with the old `formatTime` import shape used across a few pages.
 */
export const formatTime = formatTimestamp;

/** `HH:MM:SS` 24h in the browser's local TZ; use for log timestamps. */
export function formatLogTime(iso: string): string {
  return parseServerTimestamp(iso).toLocaleTimeString("en-US", { hour12: false });
}

/** Compact token count: 12345 → "12.3K", 1234567 → "1.2M". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * KPI-tile token formatter — same compact rule as {@link formatTokens} but
 * returns a caller-supplied placeholder for `null` / `undefined` / non-finite
 * (`NaN`, `±Infinity`) so the tile can render "—" instead of "0" or
 * "Infinity" when the metric is genuinely missing or an aggregator overflows.
 *
 * The non-finite guard lives here (not in every caller) so component code
 * does not have to re-derive the same `Number.isFinite(...)` check around
 * each tile's value prop.
 */
export function formatTokensWithNull(
  n: number | null | undefined,
  nullSentinel: string = "—",
): string {
  if (n == null || !Number.isFinite(n)) return nullSentinel;
  return formatTokens(n);
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
 * Millisecond-input variant of {@link formatDuration} that also handles null:
 * `null → "—"`, `<1s → "123ms"`, otherwise delegates to seconds-based formatter.
 *
 * Used by milestone/slice panels where the data layer reports `durationMs`
 * directly. Kept separate from `formatDuration` so the seconds variant doesn't
 * have to choose between Math.round-ing away sub-second precision and
 * returning bare ints.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return formatDuration(s);
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

// ─────────────────────────────────────────────────────────────────────────────
// Cost formatters — all USD, all anchored on token-cost units. The four
// helpers below cover every view in the UI; do not reintroduce locals.
// ─────────────────────────────────────────────────────────────────────────────

/** `0.4239` → `"$0.42"`. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Cost variant for null-safe display with sub-cent precision: `null → "—"`,
 * `< $0.01 → $0.0042` (4 decimals), otherwise `$0.42`.
 *
 * Used by milestone / slice / KPI panels that surface tiny per-task costs
 * where the canonical `formatCost` would round to "$0.00".
 */
export function formatCostPrecise(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Always-4-decimals USD formatter: chart tooltips, "fine spend" rows where
 * even pennies should be visible. `null` / `undefined` returns `"—"` so the
 * helper is safe to drop into a Recharts `formatter` callback.
 */
export function formatCostFine(usd: number | null | undefined): string {
  if (usd == null) return "—";
  return `$${usd.toFixed(4)}`;
}

/**
 * Cents-input formatter. `cents → "$0.42"`, with a configurable null sentinel
 * (default `"—"`) for "no data" cases. When `precise: true`, sub-dollar
 * amounts get 4 decimals. When `subDollarSentinel` is supplied (and `precise`
 * is `false`), values below 1 cent return that sentinel — useful for KPI
 * tiles that prefer `"<$0.01"` to a literal `"$0.00"`.
 *
 * One canonical cents formatter to replace the five separate copies in
 * `MissionKpiStrip`, `ProposalCard`, `CostPanel`, `MissionControlKpiBar`,
 * and `MissionEventRow`.
 */
export function formatCents(
  cents: number | null | undefined,
  opts: {
    precise?: boolean;
    nullSentinel?: string;
    subDollarSentinel?: string;
  } = {},
): string {
  const { precise = false, nullSentinel = "—", subDollarSentinel } = opts;
  if (cents == null || !Number.isFinite(cents)) return nullSentinel;
  if (subDollarSentinel !== undefined && cents > 0 && cents < 1) {
    return subDollarSentinel;
  }
  const usd = cents / 100;
  if (precise) {
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * `Intl.NumberFormat`-backed USD formatter for KPI tiles. Returns
 * `"$1,234.56"` with grouping separators. Use this when the value is
 * potentially large enough that the grouping helps readability; for compact
 * inline costs prefer `formatCost` / `formatCostPrecise`.
 *
 * `fractionDigits` controls precision (default 2). The instance is cached
 * per-precision so callers can pass arbitrary digit counts without leaking
 * a fresh `Intl.NumberFormat` per render.
 */
const _intlCache = new Map<number, Intl.NumberFormat>();
export function formatUsdIntl(
  v: number | null | undefined,
  fractionDigits: number = 2,
): string | undefined {
  if (v == null) return undefined;
  let fmt = _intlCache.get(fractionDigits);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    _intlCache.set(fractionDigits, fmt);
  }
  return fmt.format(v);
}

/**
 * Variant of {@link formatUsdIntl} that ALSO collapses non-finite inputs
 * (`NaN`, `±Infinity`) to `undefined`. Used by KPI tiles and analytics rows
 * where a server-side calc that overflows to `Infinity` should render the
 * em-dash sentinel rather than `"$Infinity"`.
 *
 * Replaces three identical local `formatUsd` wrappers that had drifted
 * across `AnalyticsKpiRow`, `DashboardKpiTiles`, and `ProjectKpiRow`.
 */
export function formatUsdGuarded(
  v: number | null | undefined,
  fractionDigits: number = 2,
): string | undefined {
  if (v == null) return undefined;
  if (!Number.isFinite(v)) return undefined;
  return formatUsdIntl(v, fractionDigits);
}

/**
 * Locale-aware date+time formatter for grids and event rows.
 * `null` / `undefined` / unparseable input → `"—"`.
 *
 * Centralises the `toLocaleString` invocation so all run/event/incident grids
 * pick up identical formatting. Replaces three local `fmtDateTime` copies
 * that had drifted on date-style options.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseServerTimestamp(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Clamp `(value / max) * 100` into `[0, 100]`. Returns `0` when `max <= 0` or
 * either input is non-finite — saves every progress-bar caller from writing
 * the same `Math.min(100, Math.max(0, …))` dance.
 */
export function clampPercent(value: number | null | undefined, max: number | null | undefined): number {
  if (value == null || max == null) return 0;
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  const pct = (value / max) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
