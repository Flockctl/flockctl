import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getAttachmentDraft,
  setAttachmentDraft,
  updateAttachmentDraft,
  clearAttachmentDraft,
  useChatAttachmentDraft,
} from "@/lib/chat-attachment-draft-store";
import type { AttachmentChipFile } from "@/components/AttachmentChip";
import { NEW_CHAT_DRAFT_KEY } from "@/lib/chat-draft-store";

function chip(id: string, status: AttachmentChipFile["status"] = "ready"): AttachmentChipFile {
  return {
    id,
    filename: `${id}.png`,
    sizeBytes: 1024,
    status,
    attachmentId: status === "ready" ? Number(id.replace(/\D/g, "")) || 1 : undefined,
  };
}

describe("chat-attachment-draft-store", () => {
  beforeEach(() => {
    clearAttachmentDraft("c-1");
    clearAttachmentDraft("c-2");
    clearAttachmentDraft(null);
    clearAttachmentDraft(NEW_CHAT_DRAFT_KEY);
  });

  it("returns a stable empty array for an unseen chat", () => {
    // `useSyncExternalStore` re-renders when the snapshot reference changes,
    // so repeated reads for an empty chat must yield the same reference.
    const a = getAttachmentDraft("never-seen");
    const b = getAttachmentDraft("never-seen");
    expect(a).toBe(b);
    expect(a).toEqual([]);
  });

  it("stores and retrieves drafts per chat id", () => {
    setAttachmentDraft("c-1", [chip("1")]);
    setAttachmentDraft("c-2", [chip("2"), chip("3")]);
    expect(getAttachmentDraft("c-1")).toHaveLength(1);
    expect(getAttachmentDraft("c-2")).toHaveLength(2);
  });

  it("clears the draft when set to an empty array", () => {
    setAttachmentDraft("c-1", [chip("1")]);
    setAttachmentDraft("c-1", []);
    expect(getAttachmentDraft("c-1")).toEqual([]);
  });

  it("updateAttachmentDraft applies a functional updater", () => {
    setAttachmentDraft("c-1", [chip("1"), chip("2")]);
    updateAttachmentDraft("c-1", (prev) => prev.filter((a) => a.id !== "1"));
    const remaining = getAttachmentDraft("c-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("2");
  });

  it("routes null chatId to the new-chat sentinel", () => {
    setAttachmentDraft(null, [chip("1")]);
    expect(getAttachmentDraft(null)).toHaveLength(1);
    expect(getAttachmentDraft(NEW_CHAT_DRAFT_KEY)).toHaveLength(1);
  });

  it("useChatAttachmentDraft surfaces writes across remounts", () => {
    const first = renderHook(() => useChatAttachmentDraft("c-1"));
    act(() => {
      first.result.current[1]([chip("1")]);
    });
    expect(first.result.current[0]).toHaveLength(1);
    first.unmount();

    // Fresh hook call simulates the ChatConversation remount on chat switch.
    const second = renderHook(() => useChatAttachmentDraft("c-1"));
    expect(second.result.current[0]).toHaveLength(1);
    expect(second.result.current[0][0]!.id).toBe("1");
  });

  it("useChatAttachmentDraft supports a functional updater", () => {
    const hook = renderHook(() => useChatAttachmentDraft("c-1"));
    act(() => hook.result.current[1]([chip("1")]));
    act(() => hook.result.current[1]((prev) => [...prev, chip("2")]));
    expect(hook.result.current[0]).toHaveLength(2);
  });

  it("useChatAttachmentDraft isolates drafts between chats", () => {
    const a = renderHook(() => useChatAttachmentDraft("c-1"));
    const b = renderHook(() => useChatAttachmentDraft("c-2"));
    act(() => a.result.current[1]([chip("1")]));
    expect(a.result.current[0]).toHaveLength(1);
    expect(b.result.current[0]).toHaveLength(0);
  });
});
