import { useMemo, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";

/**
 * Shared inline diff viewer for task change-sets and chat tool-use results.
 *
 * Accepts a raw unified-diff string (what `git diff` emits) and renders it
 * as a per-file collapsible card with hunk headers, +N/-M stats, and twin
 * (old/new) line-number gutters. The parser is intentionally forgiving —
 * it also swallows `diff --git`, `index`, `similarity`, `rename`, and
 * `\ No newline at end of file` markers without miscoloring them.
 *
 * Two entry points:
 *   <InlineDiff diff={...} />          — raw unified diff
 *   synthesizeDiffFromEdit({...})      — helper for Edit/Write tool calls
 *                                         whose payload only exposes
 *                                         old_string / new_string
 */

type LineKind = "add" | "remove" | "context" | "noeol";

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  meta: string[]; // pre-hunk metadata lines (index, mode, rename, ...)
  added: number;
  removed: number;
  isBinary: boolean;
}

/**
 * Parse a unified diff into a file-structured tree. Returns an empty array
 * when the input is blank so callers don't have to null-check.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw) return [];
  const lines = raw.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  function startFile(oldPath = "", newPath = ""): DiffFile {
    const f: DiffFile = {
      oldPath,
      newPath,
      hunks: [],
      meta: [],
      added: 0,
      removed: 0,
      isBinary: false,
    };
    current = f;
    currentHunk = null;
    files.push(f);
    return f;
  }

  for (const line of lines) {
    // File boundary: `diff --git a/foo b/bar`
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const f = startFile(match?.[1] ?? "", match?.[2] ?? "");
      f.meta.push(line);
      continue;
    }

    // Classic patch headers. If we had no `diff --git` (e.g. plain `diff -u`
    // output), synthesize a file on the fly from `---` / `+++`.
    if (line.startsWith("--- ")) {
      const f = current ?? startFile();
      const p = line.slice(4).replace(/^a\//, "").replace(/^"|"$/g, "");
      if (!f.oldPath) f.oldPath = p;
      f.meta.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const f = current ?? startFile();
      const p = line.slice(4).replace(/^b\//, "").replace(/^"|"$/g, "");
      if (!f.newPath) f.newPath = p;
      f.meta.push(line);
      continue;
    }

    if (line.startsWith("Binary files ")) {
      const f = current ?? startFile();
      f.isBinary = true;
      f.meta.push(line);
      continue;
    }

    // Hunk header: `@@ -oldStart,oldLen +newStart,newLen @@ optional section`
    if (line.startsWith("@@")) {
      const f = current ?? startFile();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      currentHunk = { header: line, lines: [] };
      f.hunks.push(currentHunk);
      continue;
    }

    // Inside a hunk. The cast re-widens `current` past TS's closure-aware
    // narrowing (writes inside startFile aren't observed here).
    const inHunkFile = current as DiffFile | null;
    if (currentHunk && inHunkFile) {
      if (line.startsWith("\\")) {
        // `\ No newline at end of file` — attach to the hunk as italic meta
        currentHunk.lines.push({ kind: "noeol", text: line });
        continue;
      }
      if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1), newNo });
        newNo += 1;
        inHunkFile.added += 1;
        continue;
      }
      if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "remove", text: line.slice(1), oldNo });
        oldNo += 1;
        inHunkFile.removed += 1;
        continue;
      }
      if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({
          kind: "context",
          text: line.startsWith(" ") ? line.slice(1) : line,
          oldNo,
          newNo,
        });
        oldNo += 1;
        newNo += 1;
        continue;
      }
    }

    // Outside a hunk but inside a file: pre-hunk metadata
    // (index, old mode, new mode, rename from/to, similarity index, etc.)
    const metaFile = current as DiffFile | null;
    if (metaFile) {
      metaFile.meta.push(line);
    }
  }

  return files;
}

/**
 * Synthesize a unified diff for an `Edit` / `Write` / `str_replace` tool
 * call so the chat can reuse the same renderer. Uses a line-level LCS so
 * unchanged runs stay as context instead of collapsing into one big
 * remove-then-add block.
 */
export function synthesizeDiffFromEdit(params: {
  filePath: string;
  oldString: string;
  newString: string;
}): string {
  const { filePath, oldString, newString } = params;
  const a = oldString.split("\n");
  const b = newString.split("\n");
  const ops = lcsLineDiff(a, b);

  const body: string[] = [];
  for (const op of ops) {
    if (op.kind === "context") body.push(" " + op.text);
    else if (op.kind === "remove") body.push("-" + op.text);
    else body.push("+" + op.text);
  }

  const header = `@@ -1,${a.length} +1,${b.length} @@`;
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    header,
    ...body,
  ].join("\n");
}

type LcsOp =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string };

/**
 * Classic O(n*m) LCS table → backtrack. Fine for Edit-tool blobs that are
 * typically under a few hundred lines; callers can fall back to treating
 * the whole thing as remove-then-add if the inputs are pathologically big.
 */
function lcsLineDiff(a: string[], b: string[]): LcsOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [
      ...a.map((t): LcsOp => ({ kind: "remove", text: t })),
      ...b.map((t): LcsOp => ({ kind: "add", text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const dpAt = (i: number, j: number): number => {
    const row = dp[i];
    return row ? (row[j] ?? 0) : 0;
  };
  const setDp = (i: number, j: number, v: number) => {
    const row = dp[i];
    if (row) row[j] = v;
  };
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      setDp(i, j, a[i] === b[j]
        ? dpAt(i + 1, j + 1) + 1
        : Math.max(dpAt(i + 1, j), dpAt(i, j + 1)));
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      ops.push({ kind: "context", text: ai });
      i++;
      j++;
    } else if (dpAt(i + 1, j) >= dpAt(i, j + 1)) {
      ops.push({ kind: "remove", text: ai });
      i++;
    } else {
      ops.push({ kind: "add", text: bj });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "remove", text: a[i++] ?? "" });
  while (j < m) ops.push({ kind: "add", text: b[j++] ?? "" });
  return ops;
}

// ---------- Rendering ----------

interface InlineDiffProps {
  diff: string;
  truncated?: boolean;
  /** Collapse files by default. Handy for big multi-file task diffs. */
  defaultCollapsed?: boolean;
  className?: string;
}

export function InlineDiff({ diff, truncated, defaultCollapsed = false, className }: InlineDiffProps) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (files.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        No changes to display.
      </div>
    );
  }

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  // Count *distinct* file paths, not `diff --git` blocks. The journal emits
  // one block per edit, so N edits to the same file would otherwise be
  // mislabeled as "N files" here while the outer summary correctly says
  // "1 file" (see src/services/file-edit-journal.ts -> summarizeJournal).
  const uniqueFileCount = new Set(
    files.map(f => f.newPath || f.oldPath).filter(Boolean)
  ).size;

  return (
    <div className={"space-y-2 " + (className ?? "")}>
      {files.length > 1 && (
        <div className="flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
          <span>{uniqueFileCount} file{uniqueFileCount === 1 ? "" : "s"}</span>
          <span className="font-mono">
            <span className="text-emerald-500 dark:text-emerald-400">+{totalAdded}</span>
            <span className="mx-1 opacity-50">/</span>
            <span className="text-red-500 dark:text-red-400">-{totalRemoved}</span>
          </span>
        </div>
      )}
      {files.map((file, idx) => (
        <DiffFileCard key={idx} file={file} defaultCollapsed={defaultCollapsed} />
      ))}
      {truncated && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          Output truncated. Showing the first portion of the diff.
        </div>
      )}
    </div>
  );
}

function DiffFileCard({ file, defaultCollapsed }: { file: DiffFile; defaultCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const path = file.newPath || file.oldPath || "(unknown file)";
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        className="flex w-full items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-left text-xs hover:bg-muted/70"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {renamed ? `${file.oldPath} → ${file.newPath}` : path}
        </span>
        {file.isBinary ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">binary</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-500 dark:text-emerald-400">+{file.added}</span>
            <span className="mx-1 opacity-50">/</span>
            <span className="text-red-500 dark:text-red-400">-{file.removed}</span>
          </span>
        )}
      </button>

      {!collapsed && !file.isBinary && (
        <div className="max-h-[32rem] overflow-auto font-mono text-[11px] leading-[1.45]">
          {file.hunks.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No hunks.</div>
          ) : (
            file.hunks.map((hunk, hIdx) => <HunkBlock key={hIdx} hunk={hunk} />)
          )}
        </div>
      )}
    </div>
  );
}

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      <div className="border-y border-border bg-blue-500/10 px-3 py-1 text-[10px] text-blue-600 dark:text-blue-300">
        {hunk.header}
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {hunk.lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === "noeol") {
    return (
      <tr>
        <td colSpan={3} className="px-3 py-0.5 text-[10px] italic text-muted-foreground">
          {line.text}
        </td>
      </tr>
    );
  }

  const rowTint =
    line.kind === "add" ? "bg-emerald-500/10"
      : line.kind === "remove" ? "bg-red-500/10"
        : "";
  const gutterTint =
    line.kind === "add" ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
      : line.kind === "remove" ? "bg-red-500/20 text-red-700 dark:text-red-300"
        : "text-muted-foreground";
  const textTint =
    line.kind === "add" ? "text-emerald-800 dark:text-emerald-200"
      : line.kind === "remove" ? "text-red-800 dark:text-red-200"
        : "";
  const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";

  return (
    <tr className={rowTint}>
      <td className={`w-10 select-none border-r border-border/60 px-1 text-right tabular-nums ${gutterTint}`}>
        {line.oldNo ?? ""}
      </td>
      <td className={`w-10 select-none border-r border-border/60 px-1 text-right tabular-nums ${gutterTint}`}>
        {line.newNo ?? ""}
      </td>
      <td className={`whitespace-pre px-2 ${textTint}`}>
        <span className="select-none opacity-50">{sign} </span>
        {line.text.length === 0 ? "\u200B" : line.text}
      </td>
    </tr>
  );
}
