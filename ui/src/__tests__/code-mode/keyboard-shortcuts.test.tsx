/**
 * Keyboard-shortcut contract for the Code-mode shell.
 *
 * The shell registers a `keydown` listener on its container ref —
 * intentionally NOT on `document` so the shortcuts don't collide with
 * other modes (Tasks, Chats, …). This suite verifies each binding by
 * dispatching a native `KeyboardEvent` against the rendered root and
 * asserting the resulting store transition (or invoked callback).
 *
 * The store is the source of truth; the shell only ever calls into the
 * existing reducer events (`focus`, `close`) — we never test rendering
 * here, only the wiring.
 *
 * Bindings under test:
 *   - Cmd/Ctrl+W → close active tab (reducer flips pendingClose on
 *                  dirty tabs; UI dialog is owned by DirtyCloseConfirm).
 *   - Cmd/Ctrl+S → invokes `onSaveActiveTab` if provided; preventsDefault
 *                  so the browser's "save page" dialog is suppressed.
 *   - Cmd/Ctrl+1..9 → focus tab at that 1-based index.
 *   - Cmd/Ctrl+]   → focus next tab (wraps).
 *   - Cmd/Ctrl+[   → focus previous tab (wraps).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { CodeMode } from "@/components/code-mode/CodeMode";
import { useEditorTabsStore } from "@/components/code-mode/tab-store";

// SourceControlPanel is reachable via the SCM activity — never mounted
// here because the default activity is "files" and we never click the
// SCM tab. Stub it anyway so a stray import doesn't pull in the query
// hooks (which would need a QueryClientProvider).
vi.mock("@/components/git/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="mock-scm-panel" />,
}));

const TARGET = {
  kind: "project" as const,
  id: "p-1",
  path: "/tmp/p-1",
};

/** Open `paths` in the store and return their generated ids in order. */
function seed(paths: string[]): string[] {
  const ids: string[] = [];
  for (const p of paths) ids.push(useEditorTabsStore.getState().open(p));
  return ids;
}

/**
 * Dispatch a native keydown against the Code-mode root. Native (not
 * synthetic) so the listener registered via `addEventListener` —
 * which is how the shell binds — actually receives the event.
 *
 * `metaKey: true` covers macOS; the shell also accepts `ctrlKey: true`
 * (Linux/Windows). Tests cover both axes via the dedicated cases below.
 */
function dispatchKey(
  init: KeyboardEventInit & { key: string },
): KeyboardEvent {
  const root = screen.getByTestId("code-mode-root");
  const ev = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  root.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  // Each test starts from an empty editor-tabs store so tab ids are
  // independent of run order.
  useEditorTabsStore.getState().__resetForTests();
});

describe("CodeMode keyboard shortcuts", () => {
  describe("Cmd+W (close)", () => {
    it("closes the active clean tab", () => {
      const ids = seed(["a.ts", "b.ts"]);
      // After seed, the LAST opened (b.ts) is active.
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "w", metaKey: true });

      const state = useEditorTabsStore.getState();
      expect(state.tabs.map((t) => t.id)).toEqual([ids[0]]);
      expect(state.activeId).toBe(ids[0]);
    });

    it("supports Ctrl+W on Linux/Windows", () => {
      const ids = seed(["a.ts", "b.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "w", ctrlKey: true });

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        ids[0],
      ]);
    });

    it("flips pendingClose without removing the tab when the buffer is dirty", () => {
      const [idA] = seed(["dirty.ts"]);
      useEditorTabsStore.getState().setDirty(idA!, true);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "w", metaKey: true });

      const state = useEditorTabsStore.getState();
      const tab = state.tabs.find((t) => t.id === idA);
      expect(tab?.pendingClose).toBe(true);
      // The tab is still open — dialog handshake decides.
      expect(state.tabs).toHaveLength(1);
    });

    it("is a no-op when no tabs are open", () => {
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "w", metaKey: true });

      expect(useEditorTabsStore.getState().tabs).toEqual([]);
    });

    it("ignores plain `w` without a modifier", () => {
      const ids = seed(["a.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "w" });

      // Tab is still open — the shortcut requires a modifier.
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(ids);
    });
  });

  describe("Cmd+1..9 (focus by index)", () => {
    it("Cmd+1 focuses the first tab", () => {
      const [idA] = seed(["a.ts", "b.ts", "c.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "1", metaKey: true });

      expect(useEditorTabsStore.getState().activeId).toBe(idA);
    });

    it("Cmd+3 focuses the third tab", () => {
      const [, , idC] = seed(["a.ts", "b.ts", "c.ts"]);
      // Pre-flight: ensure the active tab is NOT idC so the focus
      // shortcut has a measurable effect.
      const ids = useEditorTabsStore.getState().tabs;
      useEditorTabsStore.getState().focus(ids[0]!.id);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "3", metaKey: true });

      expect(useEditorTabsStore.getState().activeId).toBe(idC);
    });

    it("Cmd+5 is a no-op when only three tabs are open", () => {
      seed(["a.ts", "b.ts", "c.ts"]);
      const before = useEditorTabsStore.getState().activeId;
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "5", metaKey: true });

      expect(useEditorTabsStore.getState().activeId).toBe(before);
    });
  });

  describe("Cmd+] / Cmd+[ (next / prev)", () => {
    it("Cmd+] cycles to the next tab", () => {
      const [idA, idB] = seed(["a.ts", "b.ts"]);
      // Active starts as the last opened (b.ts) → next wraps back to a.ts.
      render(<CodeMode target={TARGET} filesPanel={null} />);
      expect(useEditorTabsStore.getState().activeId).toBe(idB);

      dispatchKey({ key: "]", metaKey: true });
      expect(useEditorTabsStore.getState().activeId).toBe(idA);

      dispatchKey({ key: "]", metaKey: true });
      expect(useEditorTabsStore.getState().activeId).toBe(idB);
    });

    it("Cmd+[ cycles to the previous tab", () => {
      const [idA, idB, idC] = seed(["a.ts", "b.ts", "c.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);
      // Active is idC. Prev → idB. Prev → idA. Prev wraps → idC.
      dispatchKey({ key: "[", metaKey: true });
      expect(useEditorTabsStore.getState().activeId).toBe(idB);

      dispatchKey({ key: "[", metaKey: true });
      expect(useEditorTabsStore.getState().activeId).toBe(idA);

      dispatchKey({ key: "[", metaKey: true });
      expect(useEditorTabsStore.getState().activeId).toBe(idC);
    });

    it("Cmd+] is a no-op when no tabs are open", () => {
      render(<CodeMode target={TARGET} filesPanel={null} />);

      dispatchKey({ key: "]", metaKey: true });

      expect(useEditorTabsStore.getState().activeId).toBeNull();
    });
  });

  describe("Cmd+S (save)", () => {
    it("invokes onSaveActiveTab", () => {
      seed(["a.ts"]);
      const onSave = vi.fn();
      render(
        <CodeMode
          target={TARGET}
          filesPanel={null}
          onSaveActiveTab={onSave}
        />,
      );

      dispatchKey({ key: "s", metaKey: true });

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("preventDefault is called so the browser's save-page dialog does not fire", () => {
      seed(["a.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      const ev = dispatchKey({ key: "s", metaKey: true });

      expect(ev.defaultPrevented).toBe(true);
    });

    it("is a no-op when onSaveActiveTab is not provided", () => {
      seed(["a.ts"]);
      // No `onSaveActiveTab` prop — the shortcut still preventDefaults
      // (so the browser doesn't trigger save-page) but does nothing else.
      render(<CodeMode target={TARGET} filesPanel={null} />);

      // Should not throw. We can't easily observe a "no-op" so this is
      // a smoke assertion: the test simply finishes without an error.
      expect(() =>
        dispatchKey({ key: "s", metaKey: true }),
      ).not.toThrow();
    });

    it("swallows callback rejections so the listener doesn't blow up", async () => {
      seed(["a.ts"]);
      const onSave = vi.fn(() => Promise.reject(new Error("boom")));
      render(
        <CodeMode
          target={TARGET}
          filesPanel={null}
          onSaveActiveTab={onSave}
        />,
      );

      dispatchKey({ key: "s", metaKey: true });
      // Resolved microtasks flush — no unhandled rejection should
      // surface from the keydown handler.
      await Promise.resolve();
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  describe("default-prevented upstream events", () => {
    it("does not act when `defaultPrevented` is already set", () => {
      const ids = seed(["a.ts", "b.ts"]);
      render(<CodeMode target={TARGET} filesPanel={null} />);

      // Simulate an upstream handler (e.g. a Monaco command palette)
      // that already consumed the event.
      const root = screen.getByTestId("code-mode-root");
      const ev = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "w",
        metaKey: true,
      });
      ev.preventDefault();
      root.dispatchEvent(ev);

      // Tab is unchanged — the shell respected the upstream prevent.
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(ids);
    });
  });
});
