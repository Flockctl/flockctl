import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  InlineDiff,
  parseUnifiedDiff,
  synthesizeDiffFromEdit,
} from "@/components/InlineDiff";

describe("parseUnifiedDiff", () => {
  it("returns an empty array for blank input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a single-file edit with correct add/remove counts and line numbers", () => {
    const raw = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,5 @@",
      " keep",
      "-bye",
      "+hello",
      "+extra",
      " end",
    ].join("\n");

    const [file] = parseUnifiedDiff(raw);
    expect(file!.oldPath).toBe("src/foo.ts");
    expect(file!.newPath).toBe("src/foo.ts");
    expect(file!.added).toBe(2);
    expect(file!.removed).toBe(1);
    expect(file!.hunks).toHaveLength(1);

    const kinds = file!.hunks[0]!.lines.map(l => l.kind);
    expect(kinds).toEqual(["context", "remove", "add", "add", "context"]);
  });

  it("splits multi-file diffs into separate DiffFile entries", () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-b",
      "+B",
    ].join("\n");

    const files = parseUnifiedDiff(raw);
    expect(files.map(f => f.newPath)).toEqual(["a.ts", "b.ts"]);
    expect(files.every(f => f.added === 1 && f.removed === 1)).toBe(true);
  });

  it("ignores `\\ No newline at end of file` in add/remove counts", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n");

    const [file] = parseUnifiedDiff(raw);
    expect(file!.added).toBe(1);
    expect(file!.removed).toBe(1);
    const noeol = file!.hunks[0]!.lines.find(l => l.kind === "noeol");
    expect(noeol?.text).toMatch(/No newline/);
  });

  it("flags binary files and preserves the marker", () => {
    const raw = [
      "diff --git a/x.png b/x.png",
      "Binary files a/x.png and b/x.png differ",
    ].join("\n");
    const [file] = parseUnifiedDiff(raw);
    expect(file!.isBinary).toBe(true);
  });

  it("tracks old/new line numbers off the hunk header", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,2 +20,3 @@",
      " ctx",
      "+added",
      " ctx2",
    ].join("\n");

    const [file] = parseUnifiedDiff(raw);
    const [ctx, added, ctx2] = file!.hunks[0]!.lines;
    expect(ctx).toMatchObject({ kind: "context", oldNo: 10, newNo: 20 });
    expect(added).toMatchObject({ kind: "add", newNo: 21 });
    expect(ctx2).toMatchObject({ kind: "context", oldNo: 11, newNo: 22 });
  });
});

describe("synthesizeDiffFromEdit", () => {
  it("emits a unified diff with a single whole-blob hunk", () => {
    const raw = synthesizeDiffFromEdit({
      filePath: "src/greet.ts",
      oldString: "hi\nbye",
      newString: "hello\nbye",
    });
    expect(raw).toContain("diff --git a/src/greet.ts b/src/greet.ts");
    expect(raw).toContain("@@ -1,2 +1,2 @@");
    expect(raw).toContain("-hi");
    expect(raw).toContain("+hello");
    expect(raw).toContain(" bye");
  });

  it("keeps shared lines as context via LCS (does not flatten to all-remove-then-all-add)", () => {
    const raw = synthesizeDiffFromEdit({
      filePath: "x.ts",
      oldString: ["a", "b", "c", "d"].join("\n"),
      newString: ["a", "B", "c", "d"].join("\n"),
    });
    const [file] = parseUnifiedDiff(raw);
    const kinds = file!.hunks[0]!.lines.map(l => l.kind);
    expect(kinds).toEqual(["context", "remove", "add", "context", "context"]);
  });
});

describe("<InlineDiff />", () => {
  it("shows the empty-state banner when there is nothing to parse", () => {
    render(<InlineDiff diff="" />);
    expect(screen.getByText(/No changes to display/i)).toBeInTheDocument();
  });

  it("renders file paths and +N/-M stats for each file in a multi-file diff", () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1,2 @@",
      " b",
      "+B2",
    ].join("\n");
    render(<InlineDiff diff={raw} />);

    // Both file paths visible
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();

    // Totals chip at the top (`2 files`)
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
  });

  it("surfaces the truncation banner when requested", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    render(<InlineDiff diff={raw} truncated />);
    expect(screen.getByText(/Output truncated/i)).toBeInTheDocument();
  });
});
