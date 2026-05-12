/**
 * Large-file UX surface — two related views the operator sees when a
 * file exceeds the daemon's 2 MiB whole-file ceiling:
 *
 *   1. {@link LargeFileTooBig} — empty-state shown by the editor when
 *      `useProjectFile` returns `{ ok: false, error_code: "fs_too_large" }`.
 *      Surfaces the on-disk size and a single primary action: "Open first
 *      64 KB read-only", which re-fires the hook with a `range` option.
 *      We intentionally avoid offering "Download" or "Open externally"
 *      here — the daemon is local, so the operator can already point an
 *      external editor at the file directly. This screen exists purely
 *      because Monaco would choke on a 50 MiB buffer in-process.
 *
 *   2. {@link LargeFilePartialBanner} — top-banner shown above the
 *      Monaco buffer when a partial open is active. Communicates two
 *      things: (a) you are seeing a slice, not the whole file; (b) the
 *      buffer is read-only because saving a slice would silently
 *      truncate the rest. Sticky / non-dismissable on purpose — losing
 *      track of "this is partial" would be a footgun.
 *
 * Both components are pure presentation: state lives in the parent
 * editor (`CodeModeEditor`), which decides when to switch from "full
 * read attempted" to "partial read confirmed".
 */
import { AlertTriangle, FileWarning } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Default partial-open window size (64 KiB). Pinned in one place so the
 *  banner copy and the actual range request can't drift. */
export const LARGE_FILE_PARTIAL_BYTES = 64 * 1024;

/**
 * Format a byte count as a short human-readable string (e.g. `64 KB`,
 * `12.3 MB`). Uses 1024-based units to match the daemon's
 * `MAX_READ_BYTES` (2 MiB) and `RANGE_SLICE_CAP` (1 MiB) constants.
 *
 * Exported so unit tests can pin the rounding behaviour and the
 * surrounding markup separately — the rendered string is the part that
 * shows up in the screenshot snapshot.
 */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  // Drop the decimal once we cross 100 — "123 MB" reads cleaner than
  // "123.0 MB" and matches every other size-string in the file tree.
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIdx]}`;
}

export interface LargeFileTooBigProps {
  /** Project-relative path the operator tried to open. Surfaced for
   *  clarity (a generic "file too big" without the path is anxiety-
   *  inducing — the operator can't tell which click triggered it). */
  path: string;
  /** Whole-file size in bytes — pulled either from the failure
   *  envelope's parsed message OR a previous fs/list response. May be
   *  omitted when the size is genuinely unknown; copy degrades to "the
   *  file is too large" without a number. */
  totalBytes?: number;
  /** Caller wires this to a state-flip that re-fires `useProjectFile`
   *  with a `range` option. */
  onOpenPartial: () => void;
}

/**
 * Empty-state shown in place of the editor when a whole-file read
 * fails with `fs_too_large`. Intentionally minimal: one icon, one
 * sentence of context, one button.
 */
export function LargeFileTooBig({
  path,
  totalBytes,
  onOpenPartial,
}: LargeFileTooBigProps) {
  const sizeCopy =
    totalBytes !== undefined
      ? `${formatBytesShort(totalBytes)} on disk`
      : "Larger than the 2 MB whole-file cap";
  return (
    <div
      data-testid="large-file-too-big"
      data-total-bytes={totalBytes ?? ""}
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <FileWarning
        className="h-8 w-8 text-muted-foreground"
        aria-hidden
      />
      <div className="space-y-1">
        <p className="text-sm font-medium">File too large to open</p>
        <p
          data-testid="large-file-too-big-path"
          className="truncate font-mono text-xs text-muted-foreground"
          title={path}
        >
          {path}
        </p>
        <p
          data-testid="large-file-too-big-size"
          className="text-xs text-muted-foreground"
        >
          {sizeCopy}
        </p>
      </div>
      <Button
        size="sm"
        onClick={onOpenPartial}
        data-testid="large-file-open-partial"
      >
        Open first {formatBytesShort(LARGE_FILE_PARTIAL_BYTES)} read-only
      </Button>
    </div>
  );
}

export interface LargeFilePartialBannerProps {
  /** Slice size actually returned by the server. May be smaller than
   *  the requested 64 KB if the file ends sooner. */
  shownBytes: number;
  /** Whole-file size on disk. Drives the "of X MB" denominator. */
  totalBytes: number;
}

/**
 * Sticky banner above the editor when a partial open is active. The
 * editor is always read-only in this mode — saving a slice would
 * truncate the rest of the file on disk, which is never what the
 * operator wants. Communicating that constraint lives entirely on this
 * banner so the editor's chrome stays minimal.
 */
export function LargeFilePartialBanner({
  shownBytes,
  totalBytes,
}: LargeFilePartialBannerProps) {
  return (
    <div
      data-testid="large-file-partial-banner"
      data-shown-bytes={shownBytes}
      data-total-bytes={totalBytes}
      role="status"
      // Match the AgentTouchedBanner palette (amber) so both
      // editor-chrome warnings read as a family.
      className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <AlertTriangle
        className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <span className="leading-snug">
        <span className="font-medium">Showing partial content</span>
        {" "}
        ({formatBytesShort(shownBytes)} of {formatBytesShort(totalBytes)}).
        Read-only.
      </span>
    </div>
  );
}
