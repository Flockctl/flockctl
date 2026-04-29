import { describe, expect, it } from "vitest";

import { isFocusedOnSameChat } from "@/lib/hooks/use-chat-reply-notifications";

/**
 * Pins the self-poke suppression rule for `chat_assistant_final`
 * notifications fired from `useChatReplyNotifications`. Mirrors the
 * `isFocusedOnSameEntity` test surface in `use-attention-notifications`
 * — a regression here means a foregrounded chat detail tab pings the
 * user with an OS notification for a reply they're already looking at.
 *
 * The rule is intentionally narrow:
 *
 *   - background tab (hasFocus=false) → never suppress, regardless of
 *     pathname; the OS notification IS the call to action.
 *   - foregrounded AND on the same chat detail → suppress.
 *   - foregrounded but anywhere else (chat list, another chat,
 *     unrelated route) → fire normally.
 */

describe("isFocusedOnSameChat", () => {
  const chatId = "chat-abc";

  it("does not suppress when the tab is in the background", () => {
    expect(isFocusedOnSameChat(chatId, `/chats/${chatId}`, false)).toBe(false);
    expect(isFocusedOnSameChat(chatId, "/chats", false)).toBe(false);
    expect(isFocusedOnSameChat(chatId, "/dashboard", false)).toBe(false);
  });

  it("suppresses when the user is on the matching chat detail and focused", () => {
    expect(isFocusedOnSameChat(chatId, `/chats/${chatId}`, true)).toBe(true);
  });

  it("does not suppress on the chat list route", () => {
    // The chat list route (`/chats`) is not "the entity the user is
    // staring at" — they're browsing the list, not the conversation —
    // so they want the ping.
    expect(isFocusedOnSameChat(chatId, "/chats", true)).toBe(false);
  });

  it("does not suppress when focused on a different chat", () => {
    expect(isFocusedOnSameChat(chatId, "/chats/other-chat", true)).toBe(false);
  });

  it("does not suppress on unrelated routes", () => {
    expect(isFocusedOnSameChat(chatId, "/dashboard", true)).toBe(false);
    expect(isFocusedOnSameChat(chatId, "/tasks/abc", true)).toBe(false);
    expect(isFocusedOnSameChat(chatId, "/", true)).toBe(false);
  });

  it("requires an exact pathname match (no prefix bleed)", () => {
    // `/chats/chat-abc/something` is not the chat detail page — fire.
    expect(
      isFocusedOnSameChat(chatId, `/chats/${chatId}/something`, true),
    ).toBe(false);
  });
});
