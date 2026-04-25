import { useCallback, useSyncExternalStore } from "react";
import type { AttachmentChipFile } from "@/components/AttachmentChip";
import { NEW_CHAT_DRAFT_KEY } from "@/lib/chat-draft-store";

/**
 * Per-chat composer attachment draft, kept in memory for the lifetime of the
 * tab.
 *
 * `ChatConversation` is remounted on every chat switch (the parent passes
 * `key={selectedChatId}`), so the composer's attachment chips — which used to
 * live in a component-local `useState` — were wiped on every navigation even
 * though the uploaded files had already been persisted server-side. This
 * store mirrors `chat-draft-store` (text drafts) but holds the chip array so
 * pending attachments survive the remount.
 *
 * Intentionally NOT persisted to localStorage. Pending attachments reference
 * rows in the `chat_attachments` table — replaying a stale draft after a
 * browser restart would either resurrect a deleted row or surprise the user.
 */

/** Shared empty-array sentinel so `useSyncExternalStore` gets a stable
 *  reference when a chat has no draft and doesn't re-render on every read. */
const EMPTY: readonly AttachmentChipFile[] = Object.freeze([]);

const drafts = new Map<string, AttachmentChipFile[]>();
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function getAttachmentDraft(
  chatId: string | null | undefined,
): AttachmentChipFile[] {
  const key = chatId ?? NEW_CHAT_DRAFT_KEY;
  return (drafts.get(key) ?? (EMPTY as AttachmentChipFile[]));
}

export function setAttachmentDraft(
  chatId: string | null | undefined,
  value: AttachmentChipFile[],
): void {
  const key = chatId ?? NEW_CHAT_DRAFT_KEY;
  const prev = drafts.get(key);
  if (prev === value) return;
  if (value.length === 0) {
    if (!prev) return;
    drafts.delete(key);
  } else {
    drafts.set(key, value);
  }
  emit();
}

export function updateAttachmentDraft(
  chatId: string | null | undefined,
  updater: (prev: AttachmentChipFile[]) => AttachmentChipFile[],
): void {
  const prev = getAttachmentDraft(chatId);
  const next = updater(prev);
  if (next === prev) return;
  setAttachmentDraft(chatId, next);
}

export function clearAttachmentDraft(chatId: string | null | undefined): void {
  setAttachmentDraft(chatId, []);
}

export type AttachmentDraftSetter = (
  next:
    | AttachmentChipFile[]
    | ((prev: AttachmentChipFile[]) => AttachmentChipFile[]),
) => void;

/**
 * React hook shaped like `useState<AttachmentChipFile[]>` but backed by the
 * module-level draft map. The returned array survives every remount of the
 * chat view, so chips stay on screen when the user toggles between chats.
 * Accepts both a direct value and a functional updater to preserve the
 * ergonomics the composer already relies on.
 */
export function useChatAttachmentDraft(
  chatId: string | null | undefined,
): [AttachmentChipFile[], AttachmentDraftSetter] {
  const value = useSyncExternalStore(
    subscribe,
    () => getAttachmentDraft(chatId),
    () => getAttachmentDraft(chatId),
  );
  const setValue = useCallback<AttachmentDraftSetter>(
    (next) => {
      if (typeof next === "function") {
        updateAttachmentDraft(chatId, next);
      } else {
        setAttachmentDraft(chatId, next);
      }
    },
    [chatId],
  );
  return [value, setValue];
}
