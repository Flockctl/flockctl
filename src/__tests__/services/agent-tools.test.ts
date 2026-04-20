import { describe, it, expect, afterAll } from "vitest";
import { getAgentTools, executeToolCall } from "../../services/agent-tools.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Agent Tools", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-test-"));

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("getAgentTools returns 9 tools", () => {
    const tools = getAgentTools(workDir);
    expect(tools).toHaveLength(9);
    const names = tools.map(t => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("MultiEdit");
    expect(names).toContain("Bash");
    expect(names).toContain("Grep");
    expect(names).toContain("Glob");
    expect(names).toContain("ListDir");
    expect(names).toContain("Delete");
  });

  it("Write creates a file", () => {
    const result = executeToolCall("Write", { path: "test.txt", content: "hello world" }, workDir);
    expect(result).toContain("File written");
  });

  it("Read reads a file", () => {
    const result = executeToolCall("Read", { path: "test.txt" }, workDir);
    expect(result).toBe("hello world");
  });

  it("Read with line range", () => {
    writeFileSync(join(workDir, "lines.txt"), "line1\nline2\nline3\nline4\n");
    const result = executeToolCall("Read", { path: "lines.txt", startLine: 2, endLine: 3 }, workDir);
    expect(result).toBe("line2\nline3");
  });

  it("Edit replaces text", () => {
    const result = executeToolCall("Edit", { path: "test.txt", oldString: "hello", newString: "goodbye" }, workDir);
    expect(result).toContain("Edited");
    const content = executeToolCall("Read", { path: "test.txt" }, workDir);
    expect(content).toBe("goodbye world");
  });

  it("Edit fails on non-unique match", () => {
    writeFileSync(join(workDir, "dup.txt"), "aaa bbb aaa");
    const result = executeToolCall("Edit", { path: "dup.txt", oldString: "aaa", newString: "ccc" }, workDir);
    expect(result).toContain("found 2 times");
  });

  it("Bash runs a command", () => {
    const result = executeToolCall("Bash", { command: "echo 'test output'" }, workDir);
    expect(result.trim()).toBe("test output");
  });

  it("Glob finds files", () => {
    writeFileSync(join(workDir, "a.ts"), "");
    writeFileSync(join(workDir, "b.ts"), "");
    const result = executeToolCall("Glob", { pattern: "*.ts" }, workDir);
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });

  it("Grep searches files", () => {
    writeFileSync(join(workDir, "search.txt"), "foo bar\nbaz qux\nfoo again\n");
    const result = executeToolCall("Grep", { pattern: "foo", path: "search.txt" }, workDir);
    expect(result).toContain("foo");
  });

  it("Read returns error for missing file", () => {
    const result = executeToolCall("Read", { path: "nonexistent.txt" }, workDir);
    expect(result).toContain("Error");
  });

  it("rejects paths outside working directory", () => {
    expect(() => executeToolCall("Read", { path: "../../../etc/passwd" }, workDir)).toThrow("outside working directory");
  });
});
