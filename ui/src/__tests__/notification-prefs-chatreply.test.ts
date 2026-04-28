import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

// The v1 storage key. The whole point of this suite is to prove the key
// remains v1 after the additive `onChatReply` field is introduced — clients
// that wrote a payload before the field existed must still load cleanly.
const STORAGE_KEY = "flockctl.notifications.v1";

let store: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    store = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
});

describe("notification-prefs: onChatReply additive field", () => {
  it("is present in DEFAULT_PREFS as `false`", () => {
    // Off-by-default matches the user spec — chat replies are seen in the UI
    // by anyone actively viewing the chat; the notification only matters for
    // someone who tabbed away mid-turn, so we don't surprise opted-in users
    // by defaulting it on.
    expect(DEFAULT_PREFS.onChatReply).toBe(false);
  });

  it("read-path: legacy v1 record without the field migrates to default-false", () => {
    // A client persisted prefs *before* this field existed. Such a payload
    // has every other known key but no `onChatReply`. The read path must
    // surface `onChatReply: false` without dropping the existing fields.
    const legacy = {
      enabled: true,
      onApprovalNeeded: false,
      onQuestionAsked: true,
      onTaskDone: true,
      onTaskFailed: true,
      onTaskBlocked: false,
      // onChatReply intentionally absent — pre-migration shape.
    };
    store[STORAGE_KEY] = JSON.stringify(legacy);

    const loaded = loadPrefs();

    expect(loaded.onChatReply).toBe(false);
    // Other fields preserved verbatim — migration is purely additive.
    expect(loaded).toEqual({ ...legacy, onChatReply: false });
  });

  it("read-path: completely empty legacy payload still gets default-false", () => {
    // Older clients in the wild may have written a `{}` after a partial
    // wipe. The merge with DEFAULT_PREFS must still default `onChatReply`.
    store[STORAGE_KEY] = JSON.stringify({});
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(loadPrefs().onChatReply).toBe(false);
  });

  it("write-path: round-trips onChatReply: true", () => {
    const next: NotificationPrefs = {
      ...DEFAULT_PREFS,
      enabled: true,
      onChatReply: true,
    };
    savePrefs(next);
    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.onChatReply).toBe(true);
    expect(loadPrefs().onChatReply).toBe(true);
    // Full round-trip identity — the new field doesn't perturb the others.
    expect(loadPrefs()).toEqual(next);
  });

  it("write-path: round-trips onChatReply: false explicitly", () => {
    // Persisted `false` must come back as `false` (not stripped, not coerced
    // to default). This guards against a save path that filters falsy values.
    const next: NotificationPrefs = {
      ...DEFAULT_PREFS,
      enabled: true,
      onChatReply: false,
    };
    savePrefs(next);
    const parsed = JSON.parse(store[STORAGE_KEY]!);
    expect(parsed.onChatReply).toBe(false);
    expect(loadPrefs().onChatReply).toBe(false);
  });

  it("storage key remains flockctl.notifications.v1 — additive change, no v2 bump", () => {
    // The contract for additive evolution: same key, merge defaults at read.
    // If anyone bumps the key to v2, every existing client silently loses
    // their saved prefs — and this test catches it.
    savePrefs({ ...DEFAULT_PREFS, enabled: true, onChatReply: true });
    expect(store[STORAGE_KEY]).toBeDefined();
    // Negative assertion: nothing landed under a v2 key.
    expect(store["flockctl.notifications.v2"]).toBeUndefined();
    // And the v1 entry holds the new field.
    const parsed = JSON.parse(store[STORAGE_KEY]!);
    expect(parsed.onChatReply).toBe(true);
  });

  it("read-path: ignores non-boolean onChatReply and falls back to default", () => {
    // Type contract is honest — a corrupted `"true"` string isn't coerced.
    store[STORAGE_KEY] = JSON.stringify({
      ...DEFAULT_PREFS,
      onChatReply: "true",
    });
    expect(loadPrefs().onChatReply).toBe(false);
  });
});
