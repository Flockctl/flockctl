import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StoredToolMessageItem } from "@/components/tool-execution";

describe("StoredToolMessageItem", () => {
  const payload = {
    kind: "call" as const,
    name: "Bash",
    input: { command: "ls", description: "list" },
    summary: "$ ls",
  };

  it("renders the tool strip when content is the raw JSON string", () => {
    const { getByTestId, getByText } = render(
      <StoredToolMessageItem id={1} content={JSON.stringify(payload)} />,
    );
    expect(getByTestId("stored-tool-message")).not.toBeNull();
    expect(getByText("Bash")).not.toBeNull();
  });

  // Regression: the API layer (toSnakeKeys + tryParseJsonString in api.ts)
  // auto-parses JSON-looking string fields, so `msg.content` arrives at the
  // component as an already-parsed object. An earlier version only called
  // JSON.parse on the prop and returned null for every tool row, leaving the
  // chat with empty wrapper divs and no tool execution strips.
  it("renders the tool strip when content is an already-parsed object", () => {
    const { getByTestId, getByText } = render(
      <StoredToolMessageItem id={1} content={payload} />,
    );
    expect(getByTestId("stored-tool-message")).not.toBeNull();
    expect(getByText("Bash")).not.toBeNull();
  });

  it("returns null for malformed content", () => {
    const { container } = render(
      <StoredToolMessageItem id={1} content="not json" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when kind is missing", () => {
    const { container } = render(
      <StoredToolMessageItem id={1} content={{ name: "Bash" }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
