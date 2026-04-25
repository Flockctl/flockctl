import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll management for the ChatConversation message list. Owns the scroll
 * element ref, tracks whether the user has scrolled up away from the tail,
 * and exposes imperative helpers for jumping back to the bottom or to a
 * specific message. Split out of ChatConversation so the page component no
 * longer has to juggle refs + effects for pure DOM mechanics.
 *
 * Callers wire the auto-scroll effect themselves — `scrollTrigger` depends on
 * transient state (message list + live blocks) that lives in the parent, and
 * embedding that effect here would force the hook to take all of it as args.
 * The `autoScrollToTail` helper keeps the implementation in one place while
 * leaving the effect dependency array with the caller.
 */
export function useChatScroll(chatId: string | null) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);
  // Reactive mirror of `userScrolledUp` — drives the "scroll to bottom"
  // floating button's visibility. Kept as state (not just a ref) so the
  // button shows/hides on every scroll event.
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp.current = !atBottom;
      setIsAtBottom(atBottom);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Reset the scroll-anchor tracker whenever the user switches to a different
  // chat — the new message list always starts anchored to the tail.
  useEffect(() => {
    setIsAtBottom(true);
    userScrolledUp.current = false;
  }, [chatId]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    userScrolledUp.current = false;
    setIsAtBottom(true);
  }, []);

  const scrollToMessage = useCallback((id: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // User jumped manually — stop auto-scrolling to bottom on new content
    // so their cursor stays on the prompt they navigated to.
    userScrolledUp.current = true;
  }, []);

  /**
   * Called from an effect whose dep array includes whatever values should
   * push scroll-to-tail (e.g. message count, live block length, streamed
   * delta lengths). Safe to call unconditionally — it no-ops when the user
   * has scrolled up.
   */
  const autoScrollToTail = useCallback(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  return {
    scrollRef,
    isAtBottom,
    scrollToBottom,
    scrollToMessage,
    autoScrollToTail,
  };
}
