import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatComposer } from "@/components/ChatComposer";
import { clearAttachmentDraft } from "@/lib/chat-attachment-draft-store";

vi.mock("@/lib/api", () => ({
  uploadChatAttachment: vi.fn(),
}));
import { uploadChatAttachment } from "@/lib/api";

const mockUpload = uploadChatAttachment as unknown as ReturnType<typeof vi.fn>;

function renderComposer(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ChatComposer
      chatId="c-1"
      value=""
      onChange={onChange}
      isStreaming={false}
      onSend={onSend}
      onCancel={onCancel}
      {...props}
    />
  );
  return { ...utils, onChange, onSend, onCancel };
}

describe("ChatComposer", () => {
  beforeEach(() => {
    // The attachment chips now live in a module-level store keyed by chatId.
    // Every test in this file renders with chatId="c-1" (and a few use
    // "c-2"), so chips seeded by earlier tests would otherwise leak into the
    // next case and corrupt assertions like "Send is disabled when empty".
    clearAttachmentDraft("c-1");
    clearAttachmentDraft("c-2");
    clearAttachmentDraft(null);
    mockUpload.mockReset();
  });

  it("uses the custom placeholder prop when provided", () => {
    renderComposer({ placeholder: "Ask about your plan..." });
    const textarea = screen.getByTestId("chat-composer-textarea");
    expect(textarea.getAttribute("placeholder")).toBe("Ask about your plan...");
  });

  it("falls back to the default placeholder when none is passed", () => {
    renderComposer();
    expect(
      screen.getByTestId("chat-composer-textarea").getAttribute("placeholder")
    ).toBe("Type a message...");
  });

  it("disables Send when value is empty", () => {
    renderComposer({ value: "" });
    const send = screen.getByTestId("chat-composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("enables Send with a non-empty value", () => {
    renderComposer({ value: "hi" });
    const send = screen.getByTestId("chat-composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it("calls onSend with trimmed value and clears textarea on send click", async () => {
    const user = userEvent.setup();
    const { onSend, onChange } = renderComposer({ value: "  hello  " });
    await user.click(screen.getByTestId("chat-composer-send"));
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("submits on Cmd/Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ value: "hi" });
    const textarea = screen.getByTestId("chat-composer-textarea");
    textarea.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalled();
  });

  it("shows cancel button and calls onCancel while streaming", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer({ value: "hi", isStreaming: true });
    // Stop renders alongside Send while a turn is in flight — Send stays
    // present so the user can line up the next prompt (parent routes those
    // into the message queue). Pre-queue behavior swapped Send for Stop,
    // which made mid-stream follow-ups impossible.
    expect(screen.queryByTestId("chat-composer-send")).not.toBeNull();
    await user.click(screen.getByTestId("chat-composer-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("keeps Send enabled while streaming so submissions can be queued", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ value: "follow-up", isStreaming: true });
    const send = screen.getByTestId("chat-composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(send.getAttribute("aria-label")).toBe("Queue message");
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith("follow-up", []);
  });

  it("disables composer when chatId is null", () => {
    renderComposer({ chatId: null });
    const textarea = screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    const paperclip = screen.getByTestId("chat-composer-paperclip") as HTMLButtonElement;
    expect(paperclip.disabled).toBe(true);
  });

  it("uploads a dropped image and enables send after it becomes ready", async () => {
    mockUpload.mockResolvedValueOnce({ id: 42 });
    const { onSend } = renderComposer({ value: "with image" });
    const input = screen.getByTestId("chat-composer-file-input") as HTMLInputElement;
    const file = new File(["pix"], "pic.png", { type: "image/png" });

    const user = userEvent.setup();
    await user.upload(input, file);

    await waitFor(() => {
      const chip = screen.getByTestId("attachment-chip");
      expect(chip.getAttribute("data-status")).toBe("ready");
    });

    await user.click(screen.getByTestId("chat-composer-send"));
    expect(onSend).toHaveBeenCalledWith("with image", [42]);
  });

  it("renders attachment chip with error when upload fails", async () => {
    mockUpload.mockRejectedValueOnce(new Error("boom"));
    renderComposer({ value: "x" });
    const input = screen.getByTestId("chat-composer-file-input") as HTMLInputElement;
    const file = new File(["pix"], "pic.png", { type: "image/png" });
    const user = userEvent.setup();
    await user.upload(input, file);

    await waitFor(() => {
      const chip = screen.getByTestId("attachment-chip");
      expect(chip.getAttribute("data-status")).toBe("error");
    });
  });

  it("preserves pending attachment chips across a remount (chat switch away and back)", async () => {
    mockUpload.mockResolvedValueOnce({ id: 77 });
    const user = userEvent.setup();

    // First mount — drop in a file and let the upload settle.
    const first = renderComposer({ value: "draft" });
    const input = screen.getByTestId("chat-composer-file-input") as HTMLInputElement;
    const file = new File(["pix"], "pic.png", { type: "image/png" });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe("ready");
    });

    // Simulate the parent remount that happens on chat navigation.
    first.unmount();

    // Second mount with the same chatId — the chip must be restored from the
    // module-level draft store, and Send must fire with the original id.
    const { onSend } = renderComposer({ value: "draft" });
    expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe("ready");
    await user.click(screen.getByTestId("chat-composer-send"));
    expect(onSend).toHaveBeenCalledWith("draft", [77]);
  });

  it("keeps each chat's attachments isolated by chatId", async () => {
    mockUpload.mockResolvedValueOnce({ id: 11 });
    const user = userEvent.setup();

    // Seed a chip into c-1.
    const chat1 = renderComposer({ chatId: "c-1", value: "one" });
    const input = screen.getByTestId("chat-composer-file-input") as HTMLInputElement;
    await user.upload(input, new File(["a"], "a.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    });
    chat1.unmount();

    // Mounting a different chat must NOT show c-1's chip.
    renderComposer({ chatId: "c-2", value: "two" });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("clears chips from the store after a successful send", async () => {
    mockUpload.mockResolvedValueOnce({ id: 9 });
    const user = userEvent.setup();

    const first = renderComposer({ value: "hi" });
    const input = screen.getByTestId("chat-composer-file-input") as HTMLInputElement;
    await user.upload(input, new File(["x"], "x.png", { type: "image/png" }));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe("ready");
    });
    await user.click(screen.getByTestId("chat-composer-send"));
    first.unmount();

    // After send the draft is empty — a fresh mount must start with no chips.
    renderComposer({ value: "" });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });
});
