/**
 * Shared adapter that turns a unified-diff string (e.g. what
 * `GET /tasks/:id/diff` emits) into the `{ original, modified }` pairs
 * Monaco's DiffEditor consumes — one pair per file in the patch.
 *
 * Why this lives here, not in `InlineDiff.tsx`:
 *   - Slice 02 already exports `parseUnifiedDiff` from `InlineDiff.tsx`
 *     to break a multi-file `git diff` blob into per-file hunks. Slice 03
 *     reuses that parser but reshapes the per-file hunks into the two
 *     full-side buffers Monaco expects.
 *   - Putting the adapter in `lib/diff/` keeps `InlineDiff.tsx` free of
 *     Monaco-specific concerns; both call sites (the inline tooltip
 *     viewer and the task-detail Monaco view) parse via the same code
 *     path.
 *
 * Caveats — important for callers:
 *   - A unified diff only carries the lines inside hunks, not the full
 *     file. The reconstructed buffers are thus the *hunk content* with
 *     hunk headers as separator comments — which is exactly what an
 *     operator wants when reviewing a change-set, but it is NOT a
 *     round-trippable replica of the on-disk file. Documented here so
 *     a reader of the produced DiffEditor doesn't expect e.g. line 1000
 *     of the source to match the model.
 *   - `isBinary` files get empty buffers — Monaco can't render binary
 *     diffs. UI surfaces should show a fallback for these.
 *   - Pure-add (status `A`) yields an empty original side; pure-delete
 *     (`D`) yields an empty modified side. Both render cleanly.
 */
import { parseUnifiedDiff } from "@/components/InlineDiff";

export interface DiffFilePair {
  /**
   * Display path. Prefers `newPath` (post-rename target), falls back to
   * `oldPath` for deletions.
   */
  path: string;
  oldPath: string;
  newPath: string;
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  added: number;
  removed: number;
}

/**
 * Reconstruct per-file Monaco-ready buffers from a unified diff.
 * Returns `[]` for an empty / unparseable input rather than throwing —
 * matches the contract of {@link parseUnifiedDiff} so callers can render
 * an empty-state UI without a defensive try/catch.
 */
export function unifiedDiffToFilePairs(raw: string): DiffFilePair[] {
  const files = parseUnifiedDiff(raw);
  return files.map((f) => {
    const path = f.newPath || f.oldPath || "";
    if (f.isBinary) {
      return {
        path,
        oldPath: f.oldPath,
        newPath: f.newPath,
        originalContent: "",
        modifiedContent: "",
        isBinary: true,
        added: f.added,
        removed: f.removed,
      };
    }

    // Walk hunks in order. Each hunk contributes its header as a
    // separator (rendered identically on both sides so the DiffEditor
    // keeps the change rows aligned to a stable anchor) followed by the
    // hunk lines split into the two sides:
    //   context → both
    //   remove  → original only
    //   add     → modified only
    //   noeol   → metadata, skipped (the `\ No newline at EOF` marker
    //             is not a content line and would otherwise bloat the
    //             buffer with a literal backslash row)
    const original: string[] = [];
    const modified: string[] = [];
    for (const hunk of f.hunks) {
      // Empty separator line keeps adjacent hunks visually distinct
      // without injecting a misleading content row.
      if (original.length > 0) original.push("");
      if (modified.length > 0) modified.push("");
      original.push(hunk.header);
      modified.push(hunk.header);
      for (const line of hunk.lines) {
        if (line.kind === "context") {
          original.push(line.text);
          modified.push(line.text);
        } else if (line.kind === "remove") {
          original.push(line.text);
        } else if (line.kind === "add") {
          modified.push(line.text);
        }
        // noeol is intentionally skipped.
      }
    }

    return {
      path,
      oldPath: f.oldPath,
      newPath: f.newPath,
      originalContent: original.join("\n"),
      modifiedContent: modified.join("\n"),
      isBinary: false,
      added: f.added,
      removed: f.removed,
    };
  });
}
