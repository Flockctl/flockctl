/**
 * Verification for the task-detail Diff tab swap.
 *
 * Slice 03 replaces the legacy {@link InlineDiff} call site in
 * `pages/task-detail.tsx` with the Monaco-backed
 * {@link "@/components/TaskDiffMonacoView"}. These tests pin the two
 * boundaries that matter:
 *
 *   1. The shared `unifiedDiffToFilePairs` adapter — slice 02's
 *      `parseUnifiedDiff` is reused, but the per-file pairs MUST split
 *      add / remove / context lines into the two side buffers Monaco
 *      consumes. A regression here would silently mis-render the diff.
 *
 *   2. The view component — given a multi-file unified diff, the
 *      sidebar must list every touched path with its +N/-M counts and
 *      mounting Monaco's DiffEditor must wire `original` / `modified`
 *      from the active row. Switching rows must re-mount the editor
 *      against the newly-active file.
 *
 * Monaco is mocked to a trivial pre/code element — the assertions only
 * need the rendered props, and jsdom can't host the real Monaco worker.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/CodeEditor", () => ({
  CodeEditor: ({
    diff,
    value,
    path,
  }: {
    diff?: { original: string };
    value: string;
    path?: string;
  }) => (
    <pre
      data-testid="mock-code-editor"
      data-path={path ?? ""}
      data-original={diff?.original ?? ""}
    >
      {value}
    </pre>
  ),
}));

import { TaskDiffMonacoView } from "@/components/TaskDiffMonacoView";
import { unifiedDiffToFilePairs } from "@/lib/diff/unified-to-pairs";

describe("unifiedDiffToFilePairs (shared adapter for the Monaco diff view)", () => {
  it("returns an empty list for blank input", () => {
    expect(unifiedDiffToFilePairs("")).toEqual([]);
  });

  it("splits a single-file edit into the original / modified buffers Monaco wants", () => {
    const raw = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-bye",
      "+hello",
    ].join("\n");

    const [pair] = unifiedDiffToFilePairs(raw);
    expect(pair?.path).toBe("src/foo.ts");
    expect(pair?.added).toBe(1);
    expect(pair?.removed).toBe(1);
    // Original carries the hunk header (used as a stable anchor in the
    // Monaco view) plus context + remove rows.
    expect(pair?.originalContent).toBe(
      ["@@ -1,3 +1,3 @@", "keep", "bye"].join("\n"),
    );
    expect(pair?.modifiedContent).toBe(
      ["@@ -1,3 +1,3 @@", "keep", "hello"].join("\n"),
    );
  });

  it("returns one pair per file in a multi-file diff", () => {
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

    const pairs = unifiedDiffToFilePairs(raw);
    expect(pairs.map((p) => p.path)).toEqual(["a.ts", "b.ts"]);
    expect(pairs[0]?.modifiedContent).toContain("A");
    expect(pairs[1]?.originalContent).toContain("b");
  });

  it("flags binary files with empty buffers (Monaco can't render them)", () => {
    const raw = [
      "diff --git a/x.png b/x.png",
      "Binary files a/x.png and b/x.png differ",
    ].join("\n");
    const [pair] = unifiedDiffToFilePairs(raw);
    expect(pair?.isBinary).toBe(true);
    expect(pair?.originalContent).toBe("");
    expect(pair?.modifiedContent).toBe("");
  });
});

describe("<TaskDiffMonacoView />", () => {
  const multiFileDiff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-bye",
    "+hello",
    "diff --git a/src/bar.ts b/src/bar.ts",
    "--- a/src/bar.ts",
    "+++ b/src/bar.ts",
    "@@ -1 +1,2 @@",
    " same",
    "+added",
  ].join("\n");

  it("renders an empty-state badge when the diff is blank", () => {
    render(<TaskDiffMonacoView diff="" />);
    expect(screen.getByTestId("task-diff-monaco-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("renders the file sidebar with one row per touched path", () => {
    render(<TaskDiffMonacoView diff={multiFileDiff} />);
    const list = screen.getByTestId("task-diff-monaco-files");
    const rows = within(list).getAllByTestId("task-diff-monaco-file");
    expect(rows.map((r) => r.getAttribute("data-path"))).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
    // Counts must be visible — operators scan the sidebar to gauge change
    // size before clicking through to the editor.
    expect(rows[0]?.textContent).toContain("+1");
    expect(rows[0]?.textContent).toContain("-1");
    expect(rows[1]?.textContent).toContain("+1");
    expect(rows[1]?.textContent).toContain("-0");
  });

  it("mounts the diff editor with the first file's buffers by default", () => {
    render(<TaskDiffMonacoView diff={multiFileDiff} />);
    const editor = screen.getByTestId("mock-code-editor");
    expect(editor).toHaveAttribute("data-path", "src/foo.ts");
    expect(editor.getAttribute("data-original") ?? "").toContain("bye");
    expect(editor.textContent ?? "").toContain("hello");
  });

  it("re-mounts the editor against the newly-active file when the sidebar selection changes", async () => {
    render(<TaskDiffMonacoView diff={multiFileDiff} />);
    const list = screen.getByTestId("task-diff-monaco-files");
    const [, secondRow] = within(list).getAllByTestId("task-diff-monaco-file");
    await userEvent.click(secondRow!);
    const editor = screen.getByTestId("mock-code-editor");
    expect(editor).toHaveAttribute("data-path", "src/bar.ts");
    expect(editor.textContent ?? "").toContain("added");
  });

  it("surfaces the truncated banner when the upstream payload is capped", () => {
    render(<TaskDiffMonacoView diff={multiFileDiff} truncated />);
    expect(
      screen.getByTestId("task-diff-monaco-truncated"),
    ).toBeInTheDocument();
  });

  it("renders the binary fallback instead of mounting Monaco for binary files", () => {
    const binaryDiff = [
      "diff --git a/x.png b/x.png",
      "Binary files a/x.png and b/x.png differ",
    ].join("\n");
    render(<TaskDiffMonacoView diff={binaryDiff} />);
    expect(screen.getByTestId("task-diff-monaco-binary")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });
});
