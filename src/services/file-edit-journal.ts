/**
 * File-edit journal — tool-call-synthesized per-session diff tracking.
 *
 * Instead of reading `git diff` against a shared working tree (which leaks
 * unrelated pre-existing working-tree changes and cross-contaminates
 * parallel chat / task sessions running in the same project), each session
 * keeps its own append-only list of `{ filePath, original, current }`
 * entries derived directly from Edit / Write / MultiEdit / str_replace tool
 * inputs. The diff shown to the user is synthesized from that journal — it
 * is session-isolated by construction, regardless of what else is happening
 * on disk.
 *
 * This mirrors how Cursor's composer and GitHub Copilot's VS Code agent
 * mode build their pending-changes view (their local edit tools emit
 * old/new pairs and the UI renders those pairs as a diff) — `git diff` of
 * the shared working tree is deliberately not on the critical path.
 *
 * Design trade-offs deliberately accepted:
 *   - Bash-driven file changes (cat > foo, sed -i, ...) do NOT appear in
 *     the journal because the tool input does not expose the affected
 *     paths or their content. This is the same blind spot Cursor and
 *     Copilot accept; it is better than showing noise from other
 *     sessions.
 *   - When the agent edits the same file multiple times in one session
 *     we store each call as its own entry. The UI renders them as N
 *     stacked hunks for that file — noisier than a single consolidated
 *     diff, but correct and cheap to compute (no state reconstruction
 *     across Claude-CLI transcript replay).
 */

export interface JournalEntry {
  /** File path as supplied by the tool input (absolute or relative — shown verbatim). */
  filePath: string;
  /** Content before the edit. Empty string = new file (Write / create_file). */
  original: string;
  /** Content after the edit. */
  current: string;
}

export interface FileEditJournal {
  entries: JournalEntry[];
}

/** Frozen shared singleton so callers can return it without worrying about mutation. */
export const EMPTY_JOURNAL: FileEditJournal = Object.freeze({ entries: [] }) as FileEditJournal;

/**
 * Parse a persisted journal JSON blob. Tolerates null / malformed payloads
 * by returning an empty journal — no error surface for legacy rows that
 * were written before this migration.
 */
export function parseJournal(raw: string | null | undefined): FileEditJournal {
  if (!raw) return { entries: [] };
  try {
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray((obj as { entries?: unknown }).entries)) {
      return { entries: [] };
    }
    const entries = ((obj as { entries: unknown[] }).entries).filter(isEntry);
    return { entries };
  } catch {
    return { entries: [] };
  }
}

function isEntry(x: unknown): x is JournalEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.filePath === "string" &&
    typeof e.original === "string" &&
    typeof e.current === "string"
  );
}

export function serializeJournal(j: FileEditJournal): string {
  return JSON.stringify({ entries: j.entries });
}

/**
 * Extract zero or more `JournalEntry`s from a single tool call. Returns an
 * empty array for non-file-modifying tools (Read, Grep, Bash, TodoWrite …)
 * so callers can unconditionally `push(...buildEntriesFromToolCall(...))`.
 *
 * Supported shapes (all common Claude / Copilot edit-tool variants):
 *   Edit                         { file_path, old_string, new_string }
 *   str_replace_editor / _based  { path,      old_str,    new_str    }
 *   MultiEdit                    { file_path, edits: [{ old_string, new_string }, …] }
 *   Write / create_file          { file_path, content }
 */
export function buildEntriesFromToolCall(name: string, input: unknown): JournalEntry[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const filePath = pickPath(obj);
  if (!filePath) return [];

  const lowered = name.toLowerCase();

  // Edit-style: single old→new swap.
  const { oldString, newString } = pickOldNew(obj);
  if (oldString !== null && newString !== null) {
    return [{ filePath, original: oldString, current: newString }];
  }

  // MultiEdit-style: array of swaps, all against the same file. Each hunk
  // is recorded as its own entry so the renderer can show them as N
  // stacked file cards — simpler than trying to apply them in sequence to
  // a synthesized base state we do not actually have.
  if (Array.isArray(obj.edits)) {
    const out: JournalEntry[] = [];
    for (const raw of obj.edits as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const ee = raw as Record<string, unknown>;
      const { oldString: o, newString: n } = pickOldNew(ee);
      if (o !== null && n !== null) {
        out.push({ filePath, original: o, current: n });
      }
    }
    return out;
  }

  // Write-style: whole-file creation or replace. We have no way to know
  // from the input whether the file existed before; treat every Write as
  // creating from empty. Noise tolerated — Cursor / Copilot do the same.
  if ((lowered === "write" || lowered === "create_file") && typeof obj.content === "string") {
    return [{ filePath, original: "", current: obj.content }];
  }

  return [];
}

function pickPath(obj: Record<string, unknown>): string {
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  return "";
}

function pickOldNew(obj: Record<string, unknown>): {
  oldString: string | null;
  newString: string | null;
} {
  const oldString =
    typeof obj.old_string === "string"
      ? obj.old_string
      : typeof obj.old_str === "string"
        ? obj.old_str
        : null;
  const newString =
    typeof obj.new_string === "string"
      ? obj.new_string
      : typeof obj.new_str === "string"
        ? obj.new_str
        : null;
  return { oldString, newString };
}

/**
 * One-line human summary of the journal — N files touched + cumulative
 * line delta. Returns `null` for an empty journal so callers can render
 * the diff card conditionally (`if (summary) <Card…>`).
 *
 * `added` / `removed` are LCS-accurate: unchanged context lines inside
 * an edit are not double-counted as both "added" and "removed".
 */
export function summarizeJournal(
  j: FileEditJournal,
): { files: number; added: number; removed: number; text: string } | null {
  if (j.entries.length === 0) return null;
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const e of j.entries) {
    files.add(e.filePath);
    const delta = countLcsDelta(e.original, e.current);
    added += delta.added;
    removed += delta.removed;
  }
  const plural = files.size === 1 ? "" : "s";
  return {
    files: files.size,
    added,
    removed,
    text: `${files.size} file${plural} changed, +${added} / -${removed}`,
  };
}

/**
 * Line-level LCS delta. Kept small and dep-free so we can run it in the
 * task executor's hot path (one call per tool_call) without pulling in
 * `diff` or similar. The pathological-input guard mirrors the one in the
 * UI renderer (`ui/src/components/InlineDiff.tsx`) so the two code paths
 * agree on when to fall back to a dumb remove-then-add count.
 */
function countLcsDelta(oldStr: string, newStr: string): { added: number; removed: number } {
  const a = oldStr === "" ? [] : oldStr.split("\n");
  const b = newStr === "" ? [] : newStr.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return { added: m, removed: n };
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      /* v8 ignore next — the dp grid is pre-filled with 0 and indexed via
         valid loop bounds; ?? 0 is TS null-safety glue that never fires. */
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  /* v8 ignore next — dp[0][0] is always a number because the grid is built
     with fill(0); the ?? 0 is TS glue only. */
  const common = dp[0]?.[0] ?? 0;
  return { added: m - common, removed: n - common };
}

/**
 * Build a unified-diff string covering every entry in the journal. The
 * output is valid `git diff`-style patch text and is consumed as-is by
 * `<InlineDiff>` on the frontend — the renderer already knows how to
 * split it into per-file cards with +/- gutters.
 *
 * Each entry produces its own `diff --git` block. If the same file is
 * touched more than once, the file appears as N adjacent blocks — the UI
 * renders them as N stacked cards, which is the honest representation of
 * "the agent edited this file N times in this session".
 */
export function renderJournalAsUnifiedDiff(j: FileEditJournal): string {
  const chunks: string[] = [];
  for (const entry of j.entries) {
    chunks.push(synthesizeDiff(entry));
  }
  return chunks.join("\n");
}

function synthesizeDiff(entry: JournalEntry): string {
  const { filePath, original, current } = entry;
  const a = original === "" ? [] : original.split("\n");
  const b = current === "" ? [] : current.split("\n");
  const ops = lcsLineDiff(a, b);

  const body: string[] = [];
  for (const op of ops) {
    if (op.kind === "context") body.push(" " + op.text);
    else if (op.kind === "remove") body.push("-" + op.text);
    else body.push("+" + op.text);
  }

  const oldLen = a.length;
  const newLen = b.length;
  const header = `@@ -${oldLen === 0 ? 0 : 1},${oldLen} +${newLen === 0 ? 0 : 1},${newLen} @@`;
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

function lcsLineDiff(a: string[], b: string[]): LcsOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [
      ...a.map((t): LcsOp => ({ kind: "remove", text: t })),
      ...b.map((t): LcsOp => ({ kind: "add", text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      /* v8 ignore next — dp is pre-filled with 0, so ?? 0 never fires. */
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i]!;
    const bj = b[j]!;
    if (ai === bj) {
      ops.push({ kind: "context", text: ai });
      i++;
      j++;
      /* v8 ignore next — dp bounds are valid during this while-loop; ?? 0 is glue. */
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "remove", text: ai });
      i++;
    } else {
      ops.push({ kind: "add", text: bj });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "remove", text: a[i++]! });
  while (j < m) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

/** Append entries from one tool call, returning a NEW journal (no mutation). */
export function appendToolCallToJournal(
  journal: FileEditJournal,
  toolName: string,
  input: unknown,
): FileEditJournal {
  const newEntries = buildEntriesFromToolCall(toolName, input);
  if (newEntries.length === 0) return journal;
  return { entries: [...journal.entries, ...newEntries] };
}
