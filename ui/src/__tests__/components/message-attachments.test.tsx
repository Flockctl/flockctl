import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageAttachments } from "@/components/MessageAttachments";

const attachments = [
  {
    id: "a-1",
    chat_id: "c-1",
    filename: "one.png",
    mime_type: "image/png",
    size_bytes: 10,
    created_at: "2026-04-20T00:00:00Z",
  },
  {
    id: "a-2",
    chat_id: "c-1",
    filename: "two.png",
    mime_type: "image/png",
    size_bytes: 20,
    created_at: "2026-04-20T00:00:00Z",
  },
];

describe("MessageAttachments", () => {
  it("renders nothing when list is empty", () => {
    const { container } = render(
      <MessageAttachments chatId="c-1" attachments={[]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one thumb per attachment", () => {
    render(<MessageAttachments chatId="c-1" attachments={attachments} />);
    const thumbs = screen.getAllByTestId("message-attachment-thumb");
    expect(thumbs).toHaveLength(2);
  });

  it("opens lightbox on thumb click and closes on backdrop click", async () => {
    const user = userEvent.setup();
    render(<MessageAttachments chatId="c-1" attachments={attachments} />);
    const thumbs = screen.getAllByTestId("message-attachment-thumb");
    await user.click(thumbs[0]!);
    const lightbox = screen.getByTestId("message-attachment-lightbox");
    expect(lightbox).toBeTruthy();

    await user.click(lightbox);
    expect(screen.queryByTestId("message-attachment-lightbox")).toBeNull();
  });

  it("closes lightbox when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<MessageAttachments chatId="c-1" attachments={attachments} />);
    await user.click(screen.getAllByTestId("message-attachment-thumb")[0]!);
    expect(screen.getByTestId("message-attachment-lightbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("message-attachment-lightbox")).toBeNull();
  });

  it("does not close lightbox when the image itself is clicked", async () => {
    const user = userEvent.setup();
    render(<MessageAttachments chatId="c-1" attachments={attachments} />);
    await user.click(screen.getAllByTestId("message-attachment-thumb")[0]!);
    const lightbox = screen.getByTestId("message-attachment-lightbox");
    const img = lightbox.querySelector("img")!;
    await user.click(img);
    // Still open.
    expect(screen.getByTestId("message-attachment-lightbox")).toBeTruthy();
  });
});
