import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, render, screen } from "@testing-library/react";

// --- localStorage mock ---
//
// `ThemeProvider` reads the persisted theme from `window.localStorage` on
// mount. Under vitest 4 + jsdom 29 + Node 25, `globalThis.localStorage`
// arrives without a `getItem` method on this codebase (a known quirk —
// other tests work around it the same way; see `view_mode_toggle_*.test.tsx`).
// Install a deterministic in-memory shim per test so the provider doesn't
// crash before the editor ever mounts.
let storageBacking: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k: string, v: string) => {
    storageBacking[k] = v;
  },
  removeItem: (k: string) => {
    delete storageBacking[k];
  },
  clear: () => {
    storageBacking = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  storageBacking = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });

  // jsdom 29 doesn't ship `window.matchMedia`; the theme provider's
  // `system` branch reaches for it the moment a non-explicit theme is
  // resolved. Hand it back a minimal "no dark preference" shim so the
  // theme test can lock the starting palette to light.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

// --- Test fixtures ---
//
// Records every `updateOptions` call made against the fake Monaco editor
// instance handed to `onMount`. The `code_editor_subscribes_to_theme_provider`
// test reads from this array to confirm the theme effect routed through
// the editor instead of remounting it.
const updateOptionsCalls: Array<Record<string, unknown>> = [];

// Counts how many times the mocked `monaco-editor` ESM entry was loaded.
// If `CodeEditor.tsx` regresses and pulls Monaco in eagerly (i.e. abandons
// the `React.lazy` boundary), this counter will tick up the moment the
// wrapper module is evaluated rather than after a Suspense resolution.
let monacoLoadCount = 0;

vi.mock("monaco-editor", () => {
  monacoLoadCount += 1;
  return {
    editor: {
      setTheme: vi.fn(),
      // M23 / T06 — the wrapper now registers two project-specific
      // themes (`flockctl-light`, `flockctl-dark`) on import and
      // re-registers them whenever the active theme flips. Returning
      // a no-op `defineTheme` keeps the mock self-sufficient — without
      // it the module-load registration call would crash.
      defineTheme: vi.fn(),
    },
  };
});

vi.mock("@monaco-editor/react", () => {
  // The wrapper subscribes to `useTheme()` and feeds Monaco the resolved
  // value via the `theme` prop *and* via `updateOptions`. To exercise both
  // paths the mock fires `onMount` synchronously inside a `useEffect` so
  // that the wrapper's own theme-change effect has a real instance to talk
  // to by the time the user flips the theme.
  const Editor = ({
    theme,
    value,
    onMount,
  }: {
    theme?: string;
    value?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    React.useEffect(() => {
      const fakeEditor = {
        updateOptions: (opts: Record<string, unknown>) => {
          updateOptionsCalls.push(opts);
        },
      };
      onMount?.(fakeEditor, {});
      // Only run on first mount — re-running would double-count.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div
        data-testid="mock-monaco"
        data-theme={theme ?? ""}
        data-value={value ?? ""}
      />
    );
  };

  const DiffEditor = ({ theme }: { theme?: string }) => (
    <div data-testid="mock-monaco-diff" data-theme={theme ?? ""} />
  );

  return {
    Editor,
    DiffEditor,
    loader: { config: vi.fn() },
  };
});

// --- Subjects under test ---
//
// Imported *after* the `vi.mock` calls. vitest hoists the mocks above any
// import statement at file scope, but listing them in this order keeps
// the intent obvious to a human reader.
import { CodeEditor } from "@/components/CodeEditor";
import { ThemeProvider, useTheme } from "@/components/theme-provider";

function ThemeController() {
  const { setTheme } = useTheme();
  return (
    <>
      <button data-testid="theme-light" onClick={() => setTheme("light")}>
        light
      </button>
      <button data-testid="theme-dark" onClick={() => setTheme("dark")}>
        dark
      </button>
    </>
  );
}

describe("<CodeEditor />", () => {
  it("code_editor_lazy_loads_monaco_chunk", async () => {
    // Importing the wrapper file is fine — its only static dep is the
    // skeleton + a `React.lazy` boundary. The Monaco runtime sits behind
    // the boundary, so the mocked monaco-editor entry must NOT have been
    // evaluated yet.
    expect(monacoLoadCount).toBe(0);

    render(
      <ThemeProvider>
        <CodeEditor value="hello" />
      </ThemeProvider>,
    );

    // The Suspense fallback shows immediately, before the dynamic import
    // resolves. If Monaco were statically imported, no skeleton would
    // ever render.
    expect(screen.queryByTestId("code-editor-skeleton")).toBeInTheDocument();

    // Suspense resolves on the next microtask once the dynamic import
    // settles. `findByTestId` waits for the mocked Monaco shell to mount,
    // which only happens through the lazy chunk.
    await screen.findByTestId("mock-monaco");

    // …and the lazy chunk pulled monaco-editor in exactly once on the way.
    expect(monacoLoadCount).toBe(1);
    expect(screen.queryByTestId("code-editor-skeleton")).not.toBeInTheDocument();
  });

  it("code_editor_subscribes_to_theme_provider", async () => {
    updateOptionsCalls.length = 0;

    render(
      <ThemeProvider>
        <CodeEditor value="x" onChange={() => {}} />
        <ThemeController />
      </ThemeProvider>,
    );

    // Mount the editor — `onMount` registers the fake instance so the
    // wrapper's theme effect has something to talk to.
    await screen.findByTestId("mock-monaco");

    // Force a known starting theme before we flip — `system` resolution in
    // jsdom is deterministic (no media query match → light) but spelling it
    // out makes the assertion below independent of `prefers-color-scheme`.
    await act(async () => {
      screen.getByTestId("theme-light").click();
    });

    await act(async () => {
      screen.getByTestId("theme-dark").click();
    });

    // The effect feeds the project's `flockctl-dark` theme through
    // `updateOptions` — *not* via a remount. Confirming both: the dark
    // call landed, and the test-id stayed stable across the flip.
    expect(updateOptionsCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ theme: "flockctl-dark" }),
      ]),
    );
    expect(screen.getByTestId("mock-monaco").getAttribute("data-theme")).toBe(
      "flockctl-dark",
    );

    // And going back to light routes through the same code path.
    await act(async () => {
      screen.getByTestId("theme-light").click();
    });
    expect(updateOptionsCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ theme: "flockctl-light" }),
      ]),
    );
  });
});
