import { describe, it, expect } from "vitest";
import {
  parseJournal,
  serializeJournal,
  buildEntriesFromToolCall,
  summarizeJournal,
  renderJournalAsUnifiedDiff,
  appendToolCallToJournal,
  type FileEditJournal,
} from "../../services/file-edit-journal.js";

describe("file-edit-journal", () => {
  describe("parseJournal", () => {
    it("returns empty journal for null / undefined / empty", () => {
      expect(parseJournal(null)).toEqual({ entries: [] });
      expect(parseJournal(undefined)).toEqual({ entries: [] });
      expect(parseJournal("")).toEqual({ entries: [] });
    });

    it("returns empty journal for malformed JSON", () => {
      expect(parseJournal("not-json")).toEqual({ entries: [] });
      expect(parseJournal("{")).toEqual({ entries: [] });
    });

    it("returns empty journal when entries is missing or not an array", () => {
      expect(parseJournal(JSON.stringify({}))).toEqual({ entries: [] });
      expect(parseJournal(JSON.stringify({ entries: "nope" }))).toEqual({ entries: [] });
      expect(parseJournal(JSON.stringify(null))).toEqual({ entries: [] });
    });

    it("filters invalid entries (missing required fields / wrong types)", () => {
      const raw = JSON.stringify({
        entries: [
          { filePath: "/a", original: "x", current: "y" },
          { filePath: 123, original: "x", current: "y" }, // bad
          { filePath: "/b", current: "y" }, // missing original
          null,
          "bogus",
          { filePath: "/c", original: "x", current: "y" },
        ],
      });
      const j = parseJournal(raw);
      expect(j.entries.map((e) => e.filePath)).toEqual(["/a", "/c"]);
    });

    it("round-trips via serializeJournal", () => {
      const j: FileEditJournal = {
        entries: [
          { filePath: "/tmp/x.ts", original: "a\nb", current: "a\nB" },
        ],
      };
      expect(parseJournal(serializeJournal(j))).toEqual(j);
    });
  });

  describe("buildEntriesFromToolCall", () => {
    it("returns [] for non-object input", () => {
      expect(buildEntriesFromToolCall("Edit", null)).toEqual([]);
      expect(buildEntriesFromToolCall("Edit", "string")).toEqual([]);
      expect(buildEntriesFromToolCall("Edit", 42)).toEqual([]);
    });

    it("returns [] for tools without a file path", () => {
      expect(buildEntriesFromToolCall("Edit", {})).toEqual([]);
      expect(buildEntriesFromToolCall("Read", { file_path: "/x" })).toEqual([]);
    });

    it("captures Edit tool calls (old_string / new_string)", () => {
      const out = buildEntriesFromToolCall("Edit", {
        file_path: "/tmp/a.ts",
        old_string: "old",
        new_string: "new",
      });
      expect(out).toEqual([{ filePath: "/tmp/a.ts", original: "old", current: "new" }]);
    });

    it("captures str_replace_editor calls (path / old_str / new_str)", () => {
      const out = buildEntriesFromToolCall("str_replace_editor", {
        path: "/tmp/b.py",
        old_str: "foo",
        new_str: "bar",
      });
      expect(out).toEqual([{ filePath: "/tmp/b.py", original: "foo", current: "bar" }]);
    });

    it("expands MultiEdit into one entry per sub-edit", () => {
      const out = buildEntriesFromToolCall("MultiEdit", {
        file_path: "/tmp/c.ts",
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "b", new_string: "B" },
          null, // invalid — skipped
          { old_str: "c", new_str: "C" },
        ],
      });
      expect(out).toEqual([
        { filePath: "/tmp/c.ts", original: "a", current: "A" },
        { filePath: "/tmp/c.ts", original: "b", current: "B" },
        { filePath: "/tmp/c.ts", original: "c", current: "C" },
      ]);
    });

    it("captures Write as an original='' whole-file create", () => {
      const out = buildEntriesFromToolCall("Write", {
        file_path: "/tmp/new.ts",
        content: "hello\nworld",
      });
      expect(out).toEqual([{ filePath: "/tmp/new.ts", original: "", current: "hello\nworld" }]);
    });

    it("captures create_file the same way as Write", () => {
      const out = buildEntriesFromToolCall("create_file", {
        path: "/tmp/new.ts",
        content: "x",
      });
      expect(out).toEqual([{ filePath: "/tmp/new.ts", original: "", current: "x" }]);
    });

    it("ignores unknown tools that happen to carry a file_path", () => {
      expect(
        buildEntriesFromToolCall("SomeRandomTool", { file_path: "/x", foo: 1 }),
      ).toEqual([]);
    });
  });

  describe("summarizeJournal", () => {
    it("returns null for an empty journal", () => {
      expect(summarizeJournal({ entries: [] })).toBeNull();
    });

    it("counts unique files and LCS-accurate line deltas", () => {
      const j: FileEditJournal = {
        entries: [
          // 1 line changed (b -> B)
          { filePath: "/a", original: "a\nb\nc", current: "a\nB\nc" },
          // 2 lines added, 0 removed
          { filePath: "/a", original: "x", current: "x\ny\nz" },
          // new file: 1 line added, 0 removed
          { filePath: "/b", original: "", current: "hello" },
        ],
      };
      const s = summarizeJournal(j);
      expect(s).toEqual({
        files: 2,
        added: 1 + 2 + 1,
        removed: 1,
        text: "2 files changed, +4 / -1",
      });
    });

    it("uses singular 'file' when only one distinct path", () => {
      const s = summarizeJournal({
        entries: [
          { filePath: "/a", original: "x", current: "y" },
          { filePath: "/a", original: "y", current: "z" },
        ],
      });
      expect(s?.text).toMatch(/^1 file changed,/);
    });
  });

  describe("renderJournalAsUnifiedDiff", () => {
    it("returns empty string for an empty journal", () => {
      expect(renderJournalAsUnifiedDiff({ entries: [] })).toBe("");
    });

    it("emits one diff --git block per entry with valid header and body", () => {
      const j: FileEditJournal = {
        entries: [
          { filePath: "/tmp/x.ts", original: "a\nb\nc", current: "a\nB\nc" },
        ],
      };
      const text = renderJournalAsUnifiedDiff(j);
      expect(text).toContain("diff --git a//tmp/x.ts b//tmp/x.ts");
      expect(text).toContain("--- a//tmp/x.ts");
      expect(text).toContain("+++ b//tmp/x.ts");
      expect(text).toContain("@@ -1,3 +1,3 @@");
      expect(text).toContain(" a");
      expect(text).toContain("-b");
      expect(text).toContain("+B");
      expect(text).toContain(" c");
    });

    it("handles whole-file creation (original empty) with 0-line old range", () => {
      const text = renderJournalAsUnifiedDiff({
        entries: [{ filePath: "/new.ts", original: "", current: "hello" }],
      });
      expect(text).toContain("@@ -0,0 +1,1 @@");
      expect(text).toContain("+hello");
    });

    it("emits N stacked blocks when the same file is edited multiple times", () => {
      const text = renderJournalAsUnifiedDiff({
        entries: [
          { filePath: "/a.ts", original: "x", current: "y" },
          { filePath: "/a.ts", original: "y", current: "z" },
        ],
      });
      const matches = text.match(/diff --git a\/\/a\.ts/g) ?? [];
      expect(matches.length).toBe(2);
    });
  });

  describe("appendToolCallToJournal", () => {
    it("returns the same journal when the tool call produces no entries", () => {
      const j: FileEditJournal = { entries: [] };
      expect(appendToolCallToJournal(j, "Read", { file_path: "/x" })).toBe(j);
    });

    it("returns a new journal with appended entries (no mutation)", () => {
      const j: FileEditJournal = {
        entries: [{ filePath: "/a", original: "1", current: "2" }],
      };
      const out = appendToolCallToJournal(j, "Edit", {
        file_path: "/b",
        old_string: "x",
        new_string: "y",
      });
      expect(out).not.toBe(j);
      expect(j.entries).toHaveLength(1); // original unchanged
      expect(out.entries).toHaveLength(2);
      expect(out.entries[1]).toEqual({ filePath: "/b", original: "x", current: "y" });
    });
  });
});
