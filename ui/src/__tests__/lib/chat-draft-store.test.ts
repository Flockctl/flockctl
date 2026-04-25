import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getDraft,
  setDraft,
  clearDraft,
  useChatDraft,
  NEW_CHAT_DRAFT_KEY,
} from "@/lib/chat-draft-store";

describe("chat-draft-store", () => {
  beforeEach(() => {
    // Each test starts with a blank slate — the store is module-level, so
    // drafts from earlier cases would otherwise leak in.
    clearDraft("c-1");
    clearDraft("c-2");
    clearDraft(null);
    clearDraft(NEW_CHAT_DRAFT_KEY);
  });

  it("stores and retrieves drafts per chat id", () => {
    setDraft("c-1", "hello");
    setDraft("c-2", "world");
    expect(getDraft("c-1")).toBe("hello");
    expect(getDraft("c-2")).toBe("world");
  });

  it("returns empty string for a chat with no draft", () => {
    expect(getDraft("never-seen")).toBe("");
  });

  it("clears the draft when set to empty string", () => {
    setDraft("c-1", "draft");
    setDraft("c-1", "");
    expect(getDraft("c-1")).toBe("");
  });

  it("routes null chatId to the new-chat sentinel", () => {
    setDraft(null, "anon draft");
    expect(getDraft(null)).toBe("anon draft");
    expect(getDraft(NEW_CHAT_DRAFT_KEY)).toBe("anon draft");
  });

  it("useChatDraft surfaces writes from setDraft (cross-mount persistence)", () => {
    const first = renderHook(() => useChatDraft("c-1"));
    act(() => {
      first.result.current[1]("typed in chat 1");
    });
    expect(first.result.current[0]).toBe("typed in chat 1");
    first.unmount();

    // Simulate the ChatConversation remount that happens on chat switch —
    // a fresh hook call for the same chatId must see the preserved draft.
    const second = renderHook(() => useChatDraft("c-1"));
    expect(second.result.current[0]).toBe("typed in chat 1");
  });

  it("useChatDraft isolates drafts between chats", () => {
    const a = renderHook(() => useChatDraft("c-1"));
    const b = renderHook(() => useChatDraft("c-2"));
    act(() => {
      a.result.current[1]("chat-one text");
    });
    expect(a.result.current[0]).toBe("chat-one text");
    expect(b.result.current[0]).toBe("");
  });

  it("useChatDraft clears when the composer calls setValue(\"\")", () => {
    const hook = renderHook(() => useChatDraft("c-1"));
    act(() => hook.result.current[1]("pending"));
    expect(hook.result.current[0]).toBe("pending");
    act(() => hook.result.current[1](""));
    expect(hook.result.current[0]).toBe("");
    expect(getDraft("c-1")).toBe("");
  });
});
