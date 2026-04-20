import { describe, it, expect } from "vitest";
import { formatToolCall, formatToolResult, truncate } from "../../services/tool-format.js";

describe("tool-format", () => {
  describe("truncate", () => {
    it("returns string unchanged when <= max", () => {
      expect(truncate("hello", 10)).toBe("hello");
      expect(truncate("hello", 5)).toBe("hello");
    });
    it("slices and appends ellipsis when longer than max", () => {
      expect(truncate("abcdef", 3)).toBe("abc…");
    });
  });

  describe("formatToolCall — Bash", () => {
    it("formats object input with multi-line command collapsed", () => {
      const out = formatToolCall("Bash", { command: "echo hi\nls" });
      expect(out).toBe("$ echo hi && ls");
    });
    it("parses JSON string input", () => {
      const out = formatToolCall("bash", JSON.stringify({ command: "pwd" }));
      expect(out).toBe("$ pwd");
    });
    it("falls back to { raw } when JSON parse fails", () => {
      const out = formatToolCall("Bash", "{ not json");
      expect(out).toMatch(/^\$ /);
    });
    it("truncates very long commands", () => {
      const long = "a".repeat(400);
      const out = formatToolCall("Bash", { command: long });
      expect(out.length).toBeLessThan(long.length + 5);
      expect(out).toContain("…");
    });
  });

  describe("formatToolCall — Read/Write/Edit", () => {
    it("Read uses file_path", () => {
      expect(formatToolCall("Read", { file_path: "/a/b.ts" })).toBe("📄 Read /a/b.ts");
    });
    it("Read uses camelCase fallback", () => {
      expect(formatToolCall("read", { filePath: "/a/b.ts" })).toBe("📄 Read /a/b.ts");
    });
    it("Write formats", () => {
      expect(formatToolCall("Write", { file_path: "/x" })).toBe("✏️ Write /x");
      expect(formatToolCall("write", { filePath: "/y" })).toBe("✏️ Write /y");
    });
    it("Edit formats", () => {
      expect(formatToolCall("Edit", { file_path: "/x" })).toBe("✏️ Edit /x");
      expect(formatToolCall("edit", { filePath: "/y" })).toBe("✏️ Edit /y");
    });
  });

  describe("formatToolCall — Glob/ListDir/Grep", () => {
    it("Glob uses pattern", () => {
      expect(formatToolCall("Glob", { pattern: "**/*.ts" })).toBe("📂 Glob **/*.ts");
    });
    it("ListDir uses path fallback", () => {
      expect(formatToolCall("ListDir", { path: "/etc" })).toBe("📂 ListDir /etc");
    });
    it("list_dir lowercase alias", () => {
      expect(formatToolCall("list_dir", { path: "/var" })).toBe("📂 list_dir /var");
    });
    it("Grep quotes and truncates", () => {
      expect(formatToolCall("Grep", { pattern: "foo" })).toBe('🔍 Grep "foo"');
      expect(formatToolCall("grep", { query: "bar" })).toBe('🔍 Grep "bar"');
      const big = "q".repeat(200);
      const out = formatToolCall("Grep", { pattern: big });
      expect(out).toContain("…");
    });
  });

  describe("formatToolCall — Skill", () => {
    it("formats with name", () => {
      expect(formatToolCall("Skill", { name: "git-commit" })).toBe("📚 Skill: git-commit");
    });
    it("uses skill fallback key", () => {
      expect(formatToolCall("skill", { skill: "alpha" })).toBe("📚 Skill: alpha");
    });
    it("includes args when present", () => {
      expect(formatToolCall("Skill", { name: "s", args: "--flag" })).toBe("📚 Skill: s — --flag");
    });
    it("unknown when missing", () => {
      expect(formatToolCall("Skill", {})).toBe("📚 Skill: unknown");
    });
  });

  describe("formatToolCall — default", () => {
    it("serializes unknown tools", () => {
      const out = formatToolCall("Custom", { a: 1 });
      expect(out).toBe('🔧 Custom {"a":1}');
    });
    it("truncates long JSON", () => {
      const huge: Record<string, number> = {};
      for (let i = 0; i < 100; i++) huge[`k${i}`] = i;
      const out = formatToolCall("X", huge);
      expect(out).toContain("…");
    });
    it("non-object non-string input becomes {}", () => {
      expect(formatToolCall("Custom", 42)).toBe("🔧 Custom {}");
      expect(formatToolCall("Custom", null)).toBe("🔧 Custom {}");
    });
  });

  describe("formatToolResult", () => {
    it("returns ✓ name when output empty", () => {
      expect(formatToolResult("Bash", "")).toBe("✓ Bash");
    });
    it("returns ✓ done when both empty", () => {
      expect(formatToolResult("", "")).toBe("✓ done");
    });
    it("collapses newlines and truncates long output", () => {
      expect(formatToolResult("Read", "a\nb")).toBe("✓ Read: a b");
      const long = "z".repeat(400);
      const out = formatToolResult("", long);
      expect(out).toContain("…");
      expect(out.startsWith("✓ ")).toBe(true);
    });
  });
});
