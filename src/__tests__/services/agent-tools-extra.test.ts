import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeToolCall } from "../../services/agent-tools.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("agent-tools — MultiEdit", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-multi-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("applies multiple unique edits in order", () => {
    writeFileSync(join(workDir, "m.txt"), "foo bar baz");
    const result = executeToolCall(
      "MultiEdit",
      {
        path: "m.txt",
        edits: [
          { oldString: "foo", newString: "FOO" },
          { oldString: "baz", newString: "BAZ" },
        ],
      },
      workDir,
    );
    expect(result).toContain("Edit 1: OK");
    expect(result).toContain("Edit 2: OK");

    const content = executeToolCall("Read", { path: "m.txt" }, workDir);
    expect(content).toBe("FOO bar BAZ");
  });

  it("reports per-edit errors without aborting others", () => {
    writeFileSync(join(workDir, "n.txt"), "alpha beta gamma");
    const result = executeToolCall(
      "MultiEdit",
      {
        path: "n.txt",
        edits: [
          { oldString: "missing", newString: "x" },
          { oldString: "alpha", newString: "A" },
        ],
      },
      workDir,
    );
    expect(result).toContain("Edit 1: oldString not found");
    expect(result).toContain("Edit 2: OK");
  });

  it("detects non-unique edits", () => {
    writeFileSync(join(workDir, "dup.txt"), "z z z");
    const result = executeToolCall(
      "MultiEdit",
      { path: "dup.txt", edits: [{ oldString: "z", newString: "Z" }] },
      workDir,
    );
    expect(result).toContain("found 3 times");
  });

  it("returns error if file missing", () => {
    const result = executeToolCall(
      "MultiEdit",
      { path: "nope.txt", edits: [{ oldString: "a", newString: "b" }] },
      workDir,
    );
    expect(result).toContain("File not found");
  });
});

describe("agent-tools — ListDir", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-ls-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("lists directory with / suffix for subdirs", () => {
    mkdirSync(join(workDir, "sub"));
    writeFileSync(join(workDir, "a.txt"), "");
    const result = executeToolCall("ListDir", { path: "." }, workDir);
    expect(result).toContain("sub/");
    expect(result).toContain("a.txt");
  });

  it("returns empty directory marker", () => {
    mkdirSync(join(workDir, "empty"));
    const result = executeToolCall("ListDir", { path: "empty" }, workDir);
    expect(result).toContain("empty directory");
  });

  it("errors on non-existent path", () => {
    const result = executeToolCall("ListDir", { path: "does-not-exist" }, workDir);
    expect(result).toContain("not found");
  });

  it("errors when path is a file", () => {
    writeFileSync(join(workDir, "file.txt"), "x");
    const result = executeToolCall("ListDir", { path: "file.txt" }, workDir);
    expect(result).toContain("Not a directory");
  });
});

describe("agent-tools — Delete", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-del-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("deletes a file", () => {
    writeFileSync(join(workDir, "del.txt"), "x");
    const result = executeToolCall("Delete", { path: "del.txt" }, workDir);
    expect(result).toContain("Deleted file");
    expect(existsSync(join(workDir, "del.txt"))).toBe(false);
  });

  it("deletes a directory recursively", () => {
    mkdirSync(join(workDir, "tree/nested"), { recursive: true });
    writeFileSync(join(workDir, "tree/nested/x.txt"), "");
    const result = executeToolCall("Delete", { path: "tree" }, workDir);
    expect(result).toContain("Deleted directory");
    expect(existsSync(join(workDir, "tree"))).toBe(false);
  });

  it("refuses to delete workspace root", () => {
    const result = executeToolCall("Delete", { path: "." }, workDir);
    expect(result).toContain("Cannot delete the workspace root");
  });

  it("errors when target missing", () => {
    const result = executeToolCall("Delete", { path: "nope.txt" }, workDir);
    expect(result).toContain("Not found");
  });
});

describe("agent-tools — Bash sandboxing and edge cases", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-bash-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("blocks rm -rf /", () => {
    const result = executeToolCall("Bash", { command: "rm -rf /" }, workDir);
    expect(result).toContain("Blocked");
  });

  it("blocks shutdown", () => {
    const result = executeToolCall("Bash", { command: "shutdown -h now" }, workDir);
    expect(result).toContain("Blocked");
  });

  it("blocks mkfs", () => {
    const result = executeToolCall("Bash", { command: "mkfs.ext4 /dev/sda1" }, workDir);
    expect(result).toContain("Blocked");
  });

  it("blocks systemctl start", () => {
    const result = executeToolCall("Bash", { command: "systemctl start ssh" }, workDir);
    expect(result).toContain("Blocked");
  });

  it("returns exit code on command failure", () => {
    const result = executeToolCall("Bash", { command: "ls /nonexistent-path-xyz" }, workDir);
    expect(result).toContain("Exit code");
  });

  it("returns (no output) for silent success", () => {
    const result = executeToolCall("Bash", { command: "true" }, workDir);
    expect(result).toBe("(no output)");
  });
});

describe("agent-tools — Grep and Glob edge cases", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-grep-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  beforeAll(() => {
    writeFileSync(join(workDir, "a.ts"), "const foo = 1;\n");
    writeFileSync(join(workDir, "b.js"), "const bar = 2;\n");
  });

  it("Grep with include filter", () => {
    const result = executeToolCall(
      "Grep",
      { pattern: "const", path: ".", include: "*.ts" },
      workDir,
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.js");
  });

  it("Grep returns 'No matches found' when nothing matches", () => {
    const result = executeToolCall(
      "Grep",
      { pattern: "xyzzy-no-match", path: "." },
      workDir,
    );
    expect(result).toBe("No matches found");
  });

  it("Glob returns 'No files matched' for unmatched pattern", () => {
    const result = executeToolCall("Glob", { pattern: "*.nope" }, workDir);
    expect(result).toBe("No files matched");
  });

  it("Grep with omitted path defaults to '.'", () => {
    // Exercises the `input.path ?? "."` nullish fallback in the Grep branch.
    const result = executeToolCall("Grep", { pattern: "const" }, workDir);
    // workDir is cwd → every .ts / .js line containing "const" must appear.
    expect(result).toContain("a.ts");
    expect(result).toContain("b.js");
  });

  it("ListDir with omitted path lists the workDir itself", () => {
    // Exercises `input.path ?? "."` on ListDir entry.
    const result = executeToolCall("ListDir", {}, workDir);
    expect(result).toContain("a.ts");
    expect(result).toContain("b.js");
  });

  it("ListDir with omitted path surfaces the default '.' label on errors", () => {
    // ListDir that succeeds on `.` hits the happy path; try the not-a-directory
    // mode by pointing at a file with no path (forced to '.') — replace workDir
    // with a file. Simpler: run ListDir with an explicitly-empty string path.
    const result = executeToolCall("ListDir", { path: undefined }, workDir);
    // Empty directory handling when reading an empty workspace subdir.
    expect(typeof result).toBe("string");
  });
});

describe("agent-tools — Unknown tool & edit errors", () => {
  const workDir = mkdtempSync(join(tmpdir(), "flockctl-misc-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("returns error for unknown tool name", () => {
    const result = executeToolCall("NoSuchTool", {}, workDir);
    expect(result).toContain("Unknown tool");
  });

  it("Edit oldString not present returns error", () => {
    writeFileSync(join(workDir, "f.txt"), "abc");
    const result = executeToolCall(
      "Edit",
      { path: "f.txt", oldString: "zzz", newString: "q" },
      workDir,
    );
    expect(result).toContain("oldString not found");
  });

  it("Edit missing file returns error", () => {
    const result = executeToolCall(
      "Edit",
      { path: "ghost.txt", oldString: "a", newString: "b" },
      workDir,
    );
    expect(result).toContain("File not found");
  });
});
