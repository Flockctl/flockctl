import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  useNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

const STORAGE_KEY = "flockctl.notifications.v1";

// Earlier suites in this project (e.g. server-store) install their own
// localStorage stub and never restore it. Reinstall a deterministic mock per
// test so file-order doesn't change behaviour.
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

describe("loadPrefs", () => {
  it("returns DEFAULT_PREFS when storage is empty", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("returns DEFAULT_PREFS when stored value is malformed JSON", () => {
    store[STORAGE_KEY] = "{not json";
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("returns DEFAULT_PREFS when stored value is null/non-object", () => {
    store[STORAGE_KEY] = JSON.stringify(null);
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    store[STORAGE_KEY] = JSON.stringify(42);
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    store[STORAGE_KEY] = JSON.stringify("string");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("merges stored partial payload with DEFAULT_PREFS (forward-compat)", () => {
    // Simulates an older client writing only a subset of fields, then a
    // newer build adding more fields. The missing keys must default in.
    store[STORAGE_KEY] = JSON.stringify({ enabled: true, onTaskFailed: false });
    expect(loadPrefs()).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskFailed: false,
    });
  });

  it("drops unknown keys from stored payload", () => {
    store[STORAGE_KEY] = JSON.stringify({
      enabled: true,
      onApprovalNeeded: false,
      legacyField: "remove me",
      anotherUnknown: 99,
    });
    const loaded = loadPrefs();
    expect(loaded).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
      onApprovalNeeded: false,
    });
    expect("legacyField" in loaded).toBe(false);
    expect("anotherUnknown" in loaded).toBe(false);
  });

  it("ignores non-boolean values for known keys", () => {
    // A corrupted payload of "true" / 1 should fall back to the default for
    // that field rather than be coerced — keeps the type contract honest.
    store[STORAGE_KEY] = JSON.stringify({
      enabled: "true",
      onTaskFailed: 0,
      onQuestionAsked: false,
    });
    expect(loadPrefs()).toEqual({
      ...DEFAULT_PREFS,
      onQuestionAsked: false,
    });
  });
});

describe("savePrefs", () => {
  it("writes a JSON payload to the v1 storage key", () => {
    const next: NotificationPrefs = {
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskDone: true,
    };
    savePrefs(next);
    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(next);
  });

  it("strips unknown keys before persisting", () => {
    // Caller hands us an object that's been polluted via legacy code.
    // Storage should never see the extras.
    const polluted = {
      ...DEFAULT_PREFS,
      enabled: true,
      legacyField: "should not survive",
    } as unknown as NotificationPrefs;
    savePrefs(polluted);
    const raw = JSON.parse(store[STORAGE_KEY]!);
    expect(raw).toEqual({ ...DEFAULT_PREFS, enabled: true });
    expect("legacyField" in raw).toBe(false);
  });

  it("swallows QuotaExceededError without throwing", () => {
    const original = mockStorage.setItem;
    mockStorage.setItem = () => {
      const err = new Error("QuotaExceededError");
      err.name = "QuotaExceededError";
      throw err;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => savePrefs({ ...DEFAULT_PREFS, enabled: true })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      mockStorage.setItem = original;
      warn.mockRestore();
    }
  });
});

describe("useNotificationPrefs", () => {
  it("seeds initial state from storage", () => {
    store[STORAGE_KEY] = JSON.stringify({ enabled: true, onTaskDone: true });
    const { result } = renderHook(() => useNotificationPrefs());
    expect(result.current[0]).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskDone: true,
    });
  });

  it("seeds DEFAULT_PREFS when nothing is stored", () => {
    const { result } = renderHook(() => useNotificationPrefs());
    expect(result.current[0]).toEqual(DEFAULT_PREFS);
  });

  it("setter persists to storage and updates state", () => {
    const { result } = renderHook(() => useNotificationPrefs());
    act(() => {
      result.current[1]({ ...DEFAULT_PREFS, enabled: true, onTaskDone: true });
    });
    expect(result.current[0]).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskDone: true,
    });
    expect(JSON.parse(store[STORAGE_KEY]!)).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskDone: true,
    });
  });

  it("propagates cross-tab changes via the storage event", () => {
    const { result } = renderHook(() => useNotificationPrefs());
    expect(result.current[0]).toEqual(DEFAULT_PREFS);

    // Simulate tab A having written a new value, then the browser dispatching
    // a storage event into tab B (this hook).
    const newValue: NotificationPrefs = {
      ...DEFAULT_PREFS,
      enabled: true,
      onApprovalNeeded: false,
    };
    store[STORAGE_KEY] = JSON.stringify(newValue);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: JSON.stringify(newValue),
        }),
      );
    });

    expect(result.current[0]).toEqual(newValue);
  });

  it("ignores storage events for unrelated keys", () => {
    const { result } = renderHook(() => useNotificationPrefs());
    const before = result.current[0];

    // Some other module's key — we should not refresh.
    store["flockctl_chat_last_read"] = JSON.stringify({ "c-1": "now" });
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "flockctl_chat_last_read",
          newValue: JSON.stringify({ "c-1": "now" }),
        }),
      );
    });

    // Reference equality is fine here — no setPrefsState was called.
    expect(result.current[0]).toEqual(before);
  });

  it("refreshes state when storage is cleared (event.key === null)", () => {
    store[STORAGE_KEY] = JSON.stringify({ ...DEFAULT_PREFS, enabled: true });
    const { result } = renderHook(() => useNotificationPrefs());
    expect(result.current[0].enabled).toBe(true);

    delete store[STORAGE_KEY];
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current[0]).toEqual(DEFAULT_PREFS);
  });

  it("setter sanitises unknown fields out of state", () => {
    const { result } = renderHook(() => useNotificationPrefs());
    act(() => {
      result.current[1]({
        ...DEFAULT_PREFS,
        enabled: true,
        legacyField: "x",
      } as unknown as NotificationPrefs);
    });
    expect("legacyField" in result.current[0]).toBe(false);
    expect(result.current[0].enabled).toBe(true);
  });
});

describe("DEFAULT_PREFS", () => {
  it("has master switch off by default", () => {
    // The whole point of `enabled: false` is that we never surprise a user
    // with a notification before they opt in. Lock it down with a test.
    expect(DEFAULT_PREFS.enabled).toBe(false);
  });

  it("has the documented per-category defaults", () => {
    expect(DEFAULT_PREFS).toEqual({
      enabled: false,
      onApprovalNeeded: true,
      onQuestionAsked: true,
      onTaskDone: false,
      onTaskFailed: true,
      onTaskBlocked: true,
      onChatReply: false,
    });
  });
});
