import { useEffect, useState } from "react";

/**
 * Browser-notification preferences, persisted in localStorage. Device-local by
 * design — desktop notification permission is bound to the browser/origin, so
 * the prefs that drive it should be too.
 *
 * The schema is intentionally a flat record of booleans so it round-trips
 * cleanly through JSON and merges trivially with `DEFAULT_PREFS` when older
 * payloads are read after a schema bump. New keys can be added without a
 * migration: missing fields fall back to their default at load time.
 *
 * Permission prompting (`Notification.requestPermission()`) lives elsewhere —
 * this module only manages the user's stated preferences.
 */

export type NotificationPrefs = {
  /** Master switch. When false, no other flag matters. Off by default. */
  enabled: boolean;
  /** Task `pending_approval`, chat permission, and task/chat permission requests. */
  onApprovalNeeded: boolean;
  /** Agent `agent_questions` for task or chat. */
  onQuestionAsked: boolean;
  /** Task `status === "done"`. Off by default — too chatty for most users. */
  onTaskDone: boolean;
  /** Task `status === "failed"`. */
  onTaskFailed: boolean;
  /** Task `status` ∈ {"cancelled", "timed_out"}. */
  onTaskBlocked: boolean;
  /**
   * Chat assistant reply arrived (terminal `final` event). Off by default —
   * users actively watching a chat see the reply in the UI; the notification
   * is for users who switched tabs/apps mid-turn.
   *
   * Additive in v1: records persisted before this field existed will have it
   * filled with `false` on first read by `pickKnown` merging with
   * `DEFAULT_PREFS`. No `v2` bump or destructive migration is required.
   */
  onChatReply: boolean;
};

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  onApprovalNeeded: true,
  onQuestionAsked: true,
  onTaskDone: false,
  onTaskFailed: true,
  onTaskBlocked: true,
  onChatReply: false,
};

// `v1` lets a future schema break (non-additive) bump to `v2` without
// colliding with deployed clients still holding the old shape.
const STORAGE_KEY = "flockctl.notifications.v1";

// Frozen list of currently-known keys. Save-time serialisation walks this
// list rather than the input object so an old payload carrying retired
// fields (e.g. after a `v2` migration) can't silently re-enter storage.
const KNOWN_KEYS = Object.keys(DEFAULT_PREFS) as ReadonlyArray<keyof NotificationPrefs>;

function safeLocalStorage(): Storage | null {
  // SSR / older test runtimes / privacy modes that nuke `window.localStorage`.
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function pickKnown(input: Record<string, unknown>): NotificationPrefs {
  // Merge with defaults so newer fields appear, then re-pick known keys so
  // unknown ones are dropped. Each known key is coerced to a boolean — a
  // corrupted entry of e.g. `"true"` should not poison downstream callers.
  const merged: NotificationPrefs = { ...DEFAULT_PREFS };
  for (const key of KNOWN_KEYS) {
    const value = input[key];
    if (typeof value === "boolean") {
      merged[key] = value;
    }
  }
  return merged;
}

export function loadPrefs(): NotificationPrefs {
  const ls = safeLocalStorage();
  if (!ls) return { ...DEFAULT_PREFS };
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFS };
    return pickKnown(parsed as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: NotificationPrefs): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  // Re-serialise only the known keys so any forward-compat fluff a caller
  // accidentally tacked on never lands in storage.
  const sanitized: NotificationPrefs = pickKnown(
    prefs as unknown as Record<string, unknown>,
  );
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (err) {
    // QuotaExceededError, SecurityError (private mode in some browsers), etc.
    // The in-memory state held by callers is still authoritative for this
    // tab, so silently swallow — log once for diagnosability.
    // eslint-disable-next-line no-console
    console.warn("notification-prefs: failed to persist", err);
  }
}

/**
 * Reactive hook. Returns `[prefs, setPrefs]` shaped like `useState`.
 *
 * - Seeded synchronously from localStorage on first render.
 * - `setPrefs(next)` writes through to storage AND updates local state.
 * - A `storage` event listener keeps tabs in sync: if tab A flips a checkbox,
 *   tab B refreshes its hook state without a reload.
 */
export function useNotificationPrefs(): [
  NotificationPrefs,
  (next: NotificationPrefs) => void,
] {
  const [prefs, setPrefsState] = useState<NotificationPrefs>(() => loadPrefs());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      // The `storage` event fires only for cross-tab writes, never for the
      // tab that issued the write. `event.key === null` happens on
      // `localStorage.clear()` — refresh state from storage in that case too.
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      setPrefsState(loadPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPrefs = (next: NotificationPrefs) => {
    savePrefs(next);
    // Re-read after save so the in-memory state matches what's actually on
    // disk (sanitized of unknown keys, coerced booleans, etc.).
    setPrefsState(pickKnown(next as unknown as Record<string, unknown>));
  };

  return [prefs, setPrefs];
}
