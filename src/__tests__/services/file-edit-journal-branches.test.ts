/**
 * Branch-coverage extras for `file-edit-journal.ts`.
 *
 * Fills:
 *   - `pickOldNew` on MultiEdit sub-edits where both old_string and new_string are missing
 *     (covers the `oldString !== null && newString !== null` false branch in the loop).
 *   - `countLcsDelta` with the pathological-input shortcut (n * m > 250_000).
 *   - `synthesizeDiff` with `current === ""` (whole-file deletion) → empty "b" side.
 *   - `lcsLineDiff` pathological fallback path.
 */
import { describe, it, expect } from "vitest";
import {
  buildEntriesFromToolCall,
  summarizeJournal,
  renderJournalAsUnifiedDiff,
} from "../../services/file-edit-journal.js";

describe("file-edit-journal — branch gaps", () => {
  it("MultiEdit with a sub-edit that has no old/new strings is skipped", () => {
    const out = buildEntriesFromToolCall("MultiEdit", {
      file_path: "/tmp/x.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { comment: "no strings here" }, // invalid — pickOldNew returns nulls
        { old_str: "b", new_str: "B" },
      ],
    });
    expect(out).toEqual([
      { filePath: "/tmp/x.ts", original: "a", current: "A" },
      { filePath: "/tmp/x.ts", original: "b", current: "B" },
    ]);
  });

  it("countLcsDelta pathological shortcut (n * m > 250_000) falls back to add-m, remove-n", () => {
    // Build two ~600-line inputs so n*m = 360_000 > 250_000 and we exercise
    // the dumb remove-then-add fallback in both countLcsDelta and lcsLineDiff.
    const oldStr = Array.from({ length: 600 }, (_, i) => `old-${i}`).join("\n");
    const newStr = Array.from({ length: 600 }, (_, i) => `new-${i}`).join("\n");
    const j = { entries: [{ filePath: "/huge.ts", original: oldStr, current: newStr }] };
    const s = summarizeJournal(j);
    // Fallback: added=m, removed=n
    expect(s?.added).toBe(600);
    expect(s?.removed).toBe(600);

    // Same input flows through renderJournalAsUnifiedDiff (lcsLineDiff fallback).
    const diff = renderJournalAsUnifiedDiff(j);
    // Every old line marked with `-`, every new line marked with `+` — nothing in context.
    // Exclude the `--- a/...` and `+++ b/...` header lines.
    const lines = diff.split("\n");
    expect(lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length).toBe(600);
    expect(lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length).toBe(600);
  });

  it("summarizeJournal handles entries with empty current text", () => {
    // Covers `newStr === "" ? [] : newStr.split("\n")` in countLcsDelta
    // (the true branch — no splitting of an empty string).
    const s = summarizeJournal({
      entries: [{ filePath: "/x.ts", original: "a\nb\nc", current: "" }],
    });
    expect(s?.added).toBe(0);
    expect(s?.removed).toBe(3);
  });

  it("summarizeJournal handles entries with empty original text", () => {
    // Covers `oldStr === "" ? [] : oldStr.split("\n")` — empty-original branch.
    const s = summarizeJournal({
      entries: [{ filePath: "/x.ts", original: "", current: "a\nb" }],
    });
    expect(s?.added).toBe(2);
    expect(s?.removed).toBe(0);
  });

  it("synthesizeDiff with current='' produces a zero-length '+' range", () => {
    const diff = renderJournalAsUnifiedDiff({
      entries: [{ filePath: "/gone.ts", original: "a\nb", current: "" }],
    });
    // Header shape: `@@ -1,N +0,0 @@` when current is empty
    expect(diff).toMatch(/@@ -1,2 \+0,0 @@/);
    expect(diff).toContain("-a");
    expect(diff).toContain("-b");
  });
});
