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

  // ---------------------------------------------------------------------------
  // M25 redesign: two-row composer (textarea on top, action row below) +
  // keybinding contract
  // ---------------------------------------------------------------------------
  // The M25 prototype splits the composer into two stacked rows inside the
  // same rounded-xl card: textarea on top, paperclip + toolbar slot + Stop /
  // Send on the bottom. The previous M24 single-row `flex items-end gap-2`
  // shell is replaced by `flex flex-col gap-1`. The block below pins the new
  // shape and the keyboard affordances (Esc clear, Tab insert, paste image,
  // Cmd+K passthrough) — losing any of these is a user-visible regression.

  it("renders the M25 two-row card shell on the dropzone wrapper", () => {
    renderComposer();
    const dropzone = screen.getByTestId("chat-composer-dropzone");
    const cls = dropzone.className;
    // Container shape pinned by the M25 prototype: a rounded-xl card with
    // the theme-aware divider-y border, surface bg-card, p-2 padding, and a
    // `flex flex-col gap-1` stack so the textarea hangs above the action
    // row instead of sharing it.
    for (const token of [
      "rounded-xl",
      "border",
      "divider-y",
      "bg-card",
      "p-2",
      "flex",
      "flex-col",
      "gap-1",
    ]) {
      expect(cls.split(/\s+/)).toContain(token);
    }
  });

  it("renders paperclip and Send inside the bottom action row, not a single shared row", () => {
    renderComposer({ value: "hi" });
    const actions = screen.getByTestId("chat-composer-actions");
    // Action row exists as its own element — paperclip + Send must live
    // here, not as siblings of the textarea. This keeps the textarea full-
    // width on the top row of the card.
    expect(actions.contains(screen.getByTestId("chat-composer-paperclip"))).toBe(true);
    expect(actions.contains(screen.getByTestId("chat-composer-send"))).toBe(true);
    // Textarea must NOT be inside the action row (regression guard against
    // accidentally collapsing back to the M24 single-row shape).
    expect(actions.contains(screen.getByTestId("chat-composer-textarea"))).toBe(false);
  });

  it("uses a mono textarea baseline", () => {
    renderComposer();
    const textarea = screen.getByTestId("chat-composer-textarea");
    // The `.mono` utility comes from index.css and is what gives the input
    // the JetBrains-Mono code feel called for in the prototype.
    expect(textarea.className.split(/\s+/)).toContain("mono");
  });

  it("clears the textarea when Esc is pressed with content", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer({ value: "draft" });
    const textarea = screen.getByTestId("chat-composer-textarea");
    textarea.focus();
    await user.keyboard("{Escape}");
    // Esc resets the controlled value to the empty string. The parent owns
    // the value, so all we can assert is that the right onChange was fired.
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does not call onChange on Esc when the textarea is already empty", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer({ value: "" });
    const textarea = screen.getByTestId("chat-composer-textarea");
    textarea.focus();
    await user.keyboard("{Escape}");
    // No change should fire — the field was empty to begin with. This guard
    // keeps Esc from "stealing" the keystroke from a parent (e.g. a modal
    // hosting the composer) that wants to handle it itself.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inserts a tab character on Tab without moving focus", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer({ value: "abc" });
    const textarea = screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
    textarea.focus();
    // Drop the caret at end-of-text so the inserted tab lands after "abc".
    textarea.setSelectionRange(3, 3);
    await user.keyboard("{Tab}");
    // Tab is intercepted: a literal \t is spliced into the controlled value
    // and focus stays on the textarea (so the user can keep typing). Without
    // preventDefault the browser would jump focus to the next tabbable.
    expect(onChange).toHaveBeenCalledWith("abc\t");
    expect(document.activeElement).toBe(textarea);
  });

  it("lets Shift+Tab fall through so focus can leave the composer", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer({ value: "abc" });
    const textarea = screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
    textarea.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    // Shift+Tab is the standard "escape this field backwards" shortcut; the
    // composer must NOT swallow it, so no \t insertion happens.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not preventDefault on Cmd+K so the global palette can claim it", async () => {
    renderComposer({ value: "" });
    const textarea = screen.getByTestId("chat-composer-textarea");
    textarea.focus();
    // Use a raw KeyboardEvent so we can inspect defaultPrevented after the
    // React handler runs. userEvent's higher-level helpers don't expose the
    // event object back to the test.
    const ev = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("uploads a pasted image instead of dumping it into the textarea", async () => {
    mockUpload.mockResolvedValueOnce({ id: 88 });
    renderComposer({ value: "" });
    const textarea = screen.getByTestId("chat-composer-textarea");
    const file = new File(["pix"], "screenshot.png", { type: "image/png" });

    // jsdom doesn't ship a working `DataTransfer` constructor, and
    // `userEvent.paste` only carries text — neither helps us hit the files
    // branch of the paste handler. Build a minimal duck-typed event the
    // handler can read: the only properties it touches are
    // `clipboardData.files` (FileList-like, with a `length` and an iterable
    // of File entries), so a one-element array masquerading as a FileList
    // is enough.
    const fakeFiles = [file] as unknown as FileList;
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { files: FileList };
    };
    Object.defineProperty(ev, "clipboardData", { value: { files: fakeFiles } });
    textarea.dispatchEvent(ev);

    // Once the paste fires, the file goes through `ingestFiles` → an
    // attachment chip materialises and the upload is requested.
    await waitFor(() => {
      expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});
