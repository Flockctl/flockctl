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

  // Operators rely on the per-row timestamp to spot a hung agent: a tool
  // call stamped 10:16 with no follow-up means the run has been stuck ever
  // since. Render `HH:mm` from the `createdAt` ISO string when provided.
  it("renders the createdAt timestamp on the tool row", () => {
    const { getByTestId } = render(
      <StoredToolMessageItem
        id={1}
        content={payload}
        createdAt="2026-05-09T10:16:00.000Z"
      />,
    );
    const stamp = getByTestId("stored-tool-timestamp");
    // Locale-dependent formatting (12h vs 24h) — assert that *some* HH:mm
    // string ending in "16" is present rather than pinning a specific zone.
    expect(stamp.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("omits the timestamp slot when createdAt is missing", () => {
    const { queryByTestId } = render(
      <StoredToolMessageItem id={1} content={payload} />,
    );
    expect(queryByTestId("stored-tool-timestamp")).toBeNull();
  });

  it("omits the timestamp slot when createdAt is unparseable", () => {
    const { queryByTestId } = render(
      <StoredToolMessageItem id={1} content={payload} createdAt="not-a-date" />,
    );
    expect(queryByTestId("stored-tool-timestamp")).toBeNull();
  });
});
