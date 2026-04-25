import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChatMessage } from "@/components/chat-message";

describe("ChatMessage", () => {
  // Regression: empty-content assistant rows (from tool-only / interrupted
  // turns) used to render as a bare `bg-muted p-3` shell, producing a column
  // of meaningless gray pills in the chat. They must render nothing.
  it("renders nothing for an empty assistant message", () => {
    const { container } = render(<ChatMessage role="assistant" content="" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a whitespace-only assistant message", () => {
    const { container } = render(<ChatMessage role="assistant" content={"   \n  "} />);
    expect(container.firstChild).toBeNull();
  });

  // Streaming placeholder keeps the shell — the caller passes `\u00A0` with
  // `isStreaming` so the user sees the "working" bubble immediately.
  it("renders the streaming placeholder bubble even when content is blank", () => {
    const { container } = render(
      <ChatMessage role="assistant" content={"\u00A0"} isStreaming />
    );
    expect(container.firstChild).not.toBeNull();
  });

  // The "agent is working" placeholder (blank content + isStreaming) shows
  // a spinner + "Thinking…" label with role=status, not a blank bubble or a
  // bare pulsing caret. Lock this in so future refactors of the placeholder
  // don't silently regress to the old empty-markdown look.
  it("shows a spinner + 'Thinking…' for the working placeholder", () => {
    const { getByRole, getByText } = render(
      <ChatMessage role="assistant" content={"\u00A0"} isStreaming />
    );
    const status = getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-label")).toBe("Agent is working");
    expect(getByText("Thinking…")).toBeTruthy();
  });

  it("renders a non-empty assistant message", () => {
    const { getByText } = render(
      <ChatMessage role="assistant" content="hello world" />
    );
    expect(getByText("hello world")).toBeTruthy();
  });

  // User bubbles are never suppressed — even an "empty" user message (which
  // the composer prevents anyway) should not silently disappear.
  it("renders a user message even if somehow empty", () => {
    const { container } = render(<ChatMessage role="user" content="" />);
    expect(container.firstChild).not.toBeNull();
  });

  // An empty assistant turn that still has attachments should render so the
  // attachment grid remains visible. (Assistant rows never carry attachments
  // in practice, but the guard keeps the contract explicit.)
  it("renders an empty assistant message that carries attachments", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content=""
        chatId="chat-1"
        attachments={[
          {
            id: "att-1",
            chat_id: "chat-1",
            filename: "pic.png",
            mime_type: "image/png",
            size_bytes: 1,
            created_at: new Date().toISOString(),
          },
        ]}
      />
    );
    expect(container.firstChild).not.toBeNull();
  });
});
