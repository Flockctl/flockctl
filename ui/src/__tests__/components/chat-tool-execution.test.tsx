import { describe, it, expect } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import {
  ToolExecutionItem,
  type ToolExecution,
} from "@/components/tool-execution";

/**
 * T02 — Tool execution accordion restyle.
 *
 * Locks in the new header contract:
 *   • tool icon + tool name + StatusPill (running/done/error) + duration
 *     (mono) + chevron — all in a single hover-affording <button> row.
 * Locks in the new expanded body contract:
 *   • args + result rendered as numbered code lines using the shared
 *     `editor-line` + `tok-*` utilities (defined in ui/src/index.css and
 *     reused from M22 slice 01 T04).
 *   • long values are capped with a "show more" button that reveals the
 *     remainder; the cap protects 500-line tool outputs from blowing out
 *     the chat scrollback.
 *   • error tools render with a danger StatusPill + an explicit error
 *     section in the body.
 *
 * The `StoredToolMessageItem` (persisted-message variant) is covered by
 * tool-execution.test.tsx in the same directory; this file covers the
 * live `ToolExecutionItem`.
 */
describe("ToolExecutionItem — header contract", () => {
  const baseTool: ToolExecution = {
    id: "t1",
    name: "Bash",
    input: { command: "ls" },
    status: "pending",
    durationMs: 1234,
  };

  it("renders tool icon + tool name + status pill + duration + chevron", () => {
    const { getByTestId } = render(<ToolExecutionItem tool={baseTool} />);
    expect(getByTestId("tool-execution")).not.toBeNull();
    expect(getByTestId("tool-icon")).not.toBeNull();
    expect(getByTestId("tool-name").textContent).toBe("Bash");
    expect(getByTestId("tool-status-pill")).not.toBeNull();
    expect(getByTestId("tool-duration")).not.toBeNull();
    expect(getByTestId("tool-chevron")).not.toBeNull();
  });

  it("uses the info pill tone for running tools and labels it 'running'", () => {
    const { getByTestId } = render(<ToolExecutionItem tool={baseTool} />);
    const pill = getByTestId("tool-status-pill");
    expect(pill.getAttribute("data-tone")).toBe("info");
    expect(pill.textContent?.toLowerCase()).toContain("running");
  });

  it("uses the success pill tone for finished tools and labels it 'done'", () => {
    const { getByTestId } = render(
      <ToolExecutionItem
        tool={{ ...baseTool, status: "success", result: { ok: true } }}
      />,
    );
    const pill = getByTestId("tool-status-pill");
    expect(pill.getAttribute("data-tone")).toBe("success");
    expect(pill.textContent?.toLowerCase()).toContain("done");
  });

  it("renders the duration in a mono font", () => {
    const { getByTestId } = render(<ToolExecutionItem tool={baseTool} />);
    const duration = getByTestId("tool-duration");
    expect(duration.className).toContain("font-mono");
    // 1234ms → 1.2s in the compact formatter.
    expect(duration.textContent).toBe("1.2s");
  });

  it("formats sub-second durations as `Nms` and minute durations as `Xm Ys`", () => {
    const { getByTestId, rerender } = render(
      <ToolExecutionItem tool={{ ...baseTool, durationMs: 850 }} />,
    );
    expect(getByTestId("tool-duration").textContent).toBe("850ms");

    rerender(<ToolExecutionItem tool={{ ...baseTool, durationMs: 65_000 }} />);
    expect(getByTestId("tool-duration").textContent).toBe("1m 5s");
  });

  it("hides the duration cell when durationMs is undefined", () => {
    const { queryByTestId } = render(
      <ToolExecutionItem tool={{ ...baseTool, durationMs: undefined }} />,
    );
    expect(queryByTestId("tool-duration")).toBeNull();
  });

  it("rotates the chevron when the accordion is expanded", () => {
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={baseTool} />,
    );
    const button = getByRole("button");
    // The chevron is an SVG element — `className` is `SVGAnimatedString`,
    // not a string, so check `classList` for the rotation class.
    const chevron = getByTestId("tool-chevron");
    expect(chevron.classList.contains("rotate-90")).toBe(false);
    fireEvent.click(button);
    expect(chevron.classList.contains("rotate-90")).toBe(true);
  });
});

describe("ToolExecutionItem — expanded body uses editor-line + tok-* utilities", () => {
  it("renders the args section with numbered editor-line rows", () => {
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "ls", description: "list files" },
      status: "pending",
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));

    const args = getByTestId("tool-args-section");
    const codeView = within(args).getByTestId("tool-code-view");
    // Every line in the JSON pretty-print maps to a single `.editor-line` row.
    const lineRows = codeView.querySelectorAll(".editor-line");
    expect(lineRows.length).toBeGreaterThan(0);
    // First line is `{` — line number `1` lives in the gutter cell.
    const firstRow = lineRows[0];
    expect(firstRow).toBeDefined();
    const firstGutter = firstRow!.querySelector(".ln");
    expect(firstGutter).not.toBeNull();
    expect(firstGutter!.textContent).toBe("1");
  });

  it("syntax-highlights JSON tokens with tok-* classes (string / key / number)", () => {
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "ls", count: 42 },
      status: "pending",
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));

    const codeView = within(getByTestId("tool-args-section")).getByTestId(
      "tool-code-view",
    );
    // Object keys → `tok-type`, string values → `tok-str`, numbers → `tok-num`.
    expect(codeView.querySelector(".tok-type")).not.toBeNull();
    expect(codeView.querySelector(".tok-str")).not.toBeNull();
    expect(codeView.querySelector(".tok-num")).not.toBeNull();
  });

  it("renders the result section as code when expanded", () => {
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
      status: "success",
      result: { stdout: "file.txt\n", exitCode: 0 },
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));

    const result = getByTestId("tool-result-section");
    const codeView = within(result).getByTestId("tool-code-view");
    expect(codeView.querySelectorAll(".editor-line").length).toBeGreaterThan(0);
    // Boolean / null / number literals must keep their own colours so a
    // result like `{ "ok": true }` reads as code, not as plain text.
    expect(codeView.querySelector(".tok-num")).not.toBeNull();
  });

  it("does not throw on a malformed (non-JSON) result — renders raw text", () => {
    // Failure-mode contract from slice spec: "Result is malformed JSON →
    // Render raw text in <pre>; do not throw."
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
      status: "success",
      result: "not-quite-json {{",
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));
    const codeView = within(getByTestId("tool-result-section")).getByTestId(
      "tool-code-view",
    );
    expect(codeView.textContent).toContain("not-quite-json {{");
  });
});

describe("ToolExecutionItem — long values capped with 'show more'", () => {
  it("caps a 500-line result with a 'show more' button by default", () => {
    const longResult = Array.from({ length: 500 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "yes" },
      status: "success",
      result: longResult,
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));

    const codeView = within(getByTestId("tool-result-section")).getByTestId(
      "tool-code-view",
    );
    // Default cap (DEFAULT_MAX_LINES = 20) — the body shows the cap, not 500.
    const lineRows = codeView.querySelectorAll(".editor-line");
    expect(lineRows.length).toBeLessThan(500);
    expect(lineRows.length).toBeLessThanOrEqual(20);
    // "Show more" affordance is present and names the remaining count so the
    // user knows the body is truncated.
    const showMore = getByTestId("tool-show-more");
    expect(showMore).not.toBeNull();
    expect(showMore.textContent).toMatch(/show more/i);
    expect(showMore.textContent).toContain("480"); // 500 - 20
  });

  it("reveals the full body when 'show more' is clicked", () => {
    const longResult = Array.from({ length: 60 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "yes" },
      status: "success",
      result: longResult,
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));

    fireEvent.click(getByTestId("tool-show-more"));

    const codeView = within(getByTestId("tool-result-section")).getByTestId(
      "tool-code-view",
    );
    const lineRows = codeView.querySelectorAll(".editor-line");
    expect(lineRows.length).toBe(60);
    // The toggle flips to "show less" so the user can re-collapse.
    expect(getByTestId("tool-show-less")).not.toBeNull();
  });

  it("does NOT render 'show more' when the value fits inside the cap", () => {
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
      status: "success",
      result: { tiny: true },
    };
    const { getByRole, queryByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );
    fireEvent.click(getByRole("button"));
    expect(queryByTestId("tool-show-more")).toBeNull();
  });
});

describe("ToolExecutionItem — error contract", () => {
  it("renders a danger pill and an error message section for failed tools", () => {
    const tool: ToolExecution = {
      id: "t1",
      name: "Bash",
      input: { command: "false" },
      status: "error",
      error: "Command failed with exit code 1",
    };
    const { getByRole, getByTestId } = render(
      <ToolExecutionItem tool={tool} />,
    );

    const pill = getByTestId("tool-status-pill");
    expect(pill.getAttribute("data-tone")).toBe("danger");
    expect(pill.textContent?.toLowerCase()).toContain("error");

    fireEvent.click(getByRole("button"));
    const errorSection = getByTestId("tool-error-section");
    expect(errorSection.textContent).toContain("Command failed with exit code 1");
  });
});
