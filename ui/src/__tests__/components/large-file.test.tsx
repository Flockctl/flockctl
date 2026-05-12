import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * Unit tests for the large-file opt-in flow that lives in
 * `<CodeModeEditor>` + `<LargeFileBanner>` + the `partial` prop on
 * `<CodeEditor>`. The slice's contract is:
 *
 *   1. When `useProjectFile` returns `{ ok: false, error_code: "fs_too_large" }`,
 *      the editor renders the {@link LargeFileTooBig} empty state with the
 *      file path and parsed size.
 *   2. Clicking "Open first 64 KB read-only" re-fires the hook with the
 *      `range: { offset: 0, length: 65536 }` option and mounts the
 *      `<CodeEditor>` with `partial = { totalBytes, shownBytes }`.
 *   3. The mounted partial editor surfaces a `LargeFilePartialBanner`
 *      with copy "Showing partial content (X KB of Y MB). Read-only."
 *   4. Cmd+S inside the partial editor is a no-op that fires a transient
 *      "Saving disabled on partial open" toast.
 *
 * Hooks are mocked at the module boundary so the test does not need a
 * QueryClientProvider, fetch shim, or live backend. Monaco is stubbed
 * with a passthrough that exposes the props we care about + a
 * `simulateCmdS` seam so the toast assertion stays synchronous.
 */

// --- Module-scope state used by mocks ---------------------------------------

interface FileQueryFixture {
  data:
    | {
        ok: true;
        content: string;
        sha: string;
        size: number;
        mtime: number;
        encoding: "utf-8";
      }
    | {
        ok: true;
        partial: true;
        content: string;
        sha: string;
        mtime: number;
        totalSize: number;
        range: { offset: number; length: number };
        encoding: "utf-8";
      }
    | { ok: false; error_code: string; message?: string }
    | undefined;
  error: unknown;
  isLoading: boolean;
}

// Captures every (path, options) pair `useProjectFile` was called with —
// the test that exercises the opt-in flow asserts the second call carried
// the `range` option (proving the React Query key swap, not just a
// re-render).
const useProjectFileCalls: Array<{
  projectId: string;
  path: string | null;
  range: { offset: number; length: number } | undefined;
}> = [];

let fileQueryFixture: FileQueryFixture;

vi.mock("@/lib/hooks", () => ({
  useProjectFile: (
    projectId: string,
    path: string | null,
    options?: { range?: { offset: number; length: number } },
  ) => {
    useProjectFileCalls.push({
      projectId,
      path,
      range: options?.range,
    });
    return fileQueryFixture;
  },
}));

// `useTabState` lives next to the fs-changed handler. We don't exercise
// the conflict banner from this test, so the simplest stub is one that
// returns a stable "no conflict" snapshot, plus a passthrough store.
vi.mock("@/lib/handlers/fs-changed", () => {
  type Tab = {
    projectId: string;
    path: string;
    heldSha: string;
    dirty: boolean;
    conflict: { kind: "none" | "conflict"; source?: string };
  };
  const tabs = new Map<string, Tab>();
  const key = (p: string, q: string) => `${p}|${q}`;
  return {
    fsTabStore: {
      get: (p: string, q: string) => tabs.get(key(p, q)),
      register: (t: Tab) => {
        tabs.set(key(t.projectId, t.path), t);
        return () => tabs.delete(key(t.projectId, t.path));
      },
      update: (p: string, q: string, patch: Partial<Tab>) => {
        const cur = tabs.get(key(p, q));
        if (!cur) return;
        tabs.set(key(p, q), { ...cur, ...patch });
      },
    },
    useTabState: () => ({
      dirty: false,
      conflict: { kind: "none" },
    }),
  };
});

// Monaco stub. Two shapes we care about:
//   - The `<Editor>` records every `partial` prop that flows through the
//     CodeEditor's wrapper, so the assertion can pin the exact value the
//     editor mounted with.
//   - `onMount` is fired synchronously so the partial-mode Cmd+S
//     command can be registered without a Suspense round-trip.
// The fake Monaco module exposes a `simulateCmdS` function the test calls
// to invoke the registered handler — Monaco's real `addCommand` is a
// black box from this layer.

interface RegisteredCommand {
  keybinding: number;
  handler: () => void;
}

const registeredCommands: RegisteredCommand[] = [];

(globalThis as unknown as { __simulateCmdS: () => void }).__simulateCmdS =
  () => {
    // Replay every registered handler — a partial editor only registers
    // one, but a future edit that adds more should still be exercised
    // by this test's invariant.
    for (const c of registeredCommands) c.handler();
  };

vi.mock("@monaco-editor/react", () => {
  const Editor = ({
    value,
    onMount,
  }: {
    value?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    React.useEffect(() => {
      const editor = {
        addCommand: (keybinding: number, handler: () => void) => {
          registeredCommands.push({ keybinding, handler });
        },
        updateOptions: () => {},
      };
      const monacoNs = {
        KeyMod: { CtrlCmd: 0x4000 },
        KeyCode: { KeyS: 49 },
      };
      onMount?.(editor, monacoNs);
      // Run on first mount only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="mock-monaco" data-value={value ?? ""} />;
  };
  const DiffEditor = () => <div data-testid="mock-monaco-diff" />;
  return {
    Editor,
    DiffEditor,
    loader: { config: vi.fn() },
  };
});

vi.mock("monaco-editor", () => ({
  // M23 / T06 — `defineTheme` is needed for the Flockctl Monaco theme
  // registration that runs at module load.
  editor: { setTheme: vi.fn(), defineTheme: vi.fn() },
}));

// localStorage + matchMedia shim, mirrored from `code-editor.test.tsx`.
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
  useProjectFileCalls.length = 0;
  registeredCommands.length = 0;
});

// --- Subjects ---------------------------------------------------------------

import { CodeModeEditor, parseTooLargeSize } from "@/components/code-mode/CodeModeEditor";
import {
  formatBytesShort,
  LARGE_FILE_PARTIAL_BYTES,
} from "@/components/code-mode/LargeFileBanner";
import { ThemeProvider } from "@/components/theme-provider";

function renderEditor() {
  return render(
    <ThemeProvider>
      <CodeModeEditor projectId="42" path="logs/big.log" />
    </ThemeProvider>,
  );
}

describe("parseTooLargeSize", () => {
  it("parses_size_from_daemon_message", () => {
    expect(
      parseTooLargeSize("file is 12345678 bytes; 2097152-byte cap exceeded"),
    ).toBe(12345678);
  });

  it("returns_undefined_for_unparseable_message", () => {
    expect(parseTooLargeSize(undefined)).toBeUndefined();
    expect(parseTooLargeSize("something else")).toBeUndefined();
    expect(parseTooLargeSize("file is zero bytes")).toBeUndefined();
  });
});

describe("formatBytesShort", () => {
  it("renders_short_unit_strings", () => {
    expect(formatBytesShort(0)).toBe("0 B");
    expect(formatBytesShort(512)).toBe("512 B");
    // 64 KiB exactly — KB.
    expect(formatBytesShort(64 * 1024)).toBe("64 KB");
    // 12.5 MiB — drops decimal once value < 100 stays one digit.
    expect(formatBytesShort(Math.round(12.5 * 1024 * 1024))).toBe("12.5 MB");
    // > 100 — drop the decimal entirely.
    expect(formatBytesShort(123 * 1024 * 1024)).toBe("123 MB");
  });

  it("clamps_negative_or_nonfinite_input", () => {
    expect(formatBytesShort(-1)).toBe("0 B");
    expect(formatBytesShort(Number.NaN)).toBe("0 B");
  });
});

describe("<CodeModeEditor /> large-file flow", () => {
  it("renders_LargeFileTooBig_with_size_when_fs_too_large", async () => {
    fileQueryFixture = {
      data: {
        ok: false,
        error_code: "fs_too_large",
        message: "file is 12582912 bytes; 2097152-byte cap exceeded",
      },
      error: null,
      isLoading: false,
    };

    renderEditor();

    expect(await screen.findByTestId("large-file-too-big")).toBeInTheDocument();
    expect(
      screen.getByTestId("large-file-too-big-path").textContent,
    ).toBe("logs/big.log");
    // 12 * 1024 * 1024 = 12582912 → "12 MB"
    expect(
      screen.getByTestId("large-file-too-big-size").textContent,
    ).toContain("12 MB");

    const button = screen.getByTestId("large-file-open-partial");
    expect(button).toHaveTextContent("Open first 64 KB read-only");

    // Pre-click: hook called with no range.
    expect(useProjectFileCalls.some((c) => c.range !== undefined)).toBe(false);
  });

  it(
    "clicking_open_partial_re-fires_useProjectFile_with_range_option",
    async () => {
      fileQueryFixture = {
        data: {
          ok: false,
          error_code: "fs_too_large",
          message: "file is 12582912 bytes; 2097152-byte cap exceeded",
        },
        error: null,
        isLoading: false,
      };

      renderEditor();

      const button = await screen.findByTestId("large-file-open-partial");
      await act(async () => {
        fireEvent.click(button);
      });

      // After the click, the next render fires `useProjectFile` with the
      // default 64 KB window starting at offset 0.
      const lastCall = useProjectFileCalls.at(-1);
      expect(lastCall?.range).toEqual({
        offset: 0,
        length: LARGE_FILE_PARTIAL_BYTES,
      });
    },
  );

  it(
    "renders_partial_banner_and_forces_read_only_when_partial_response_lands",
    async () => {
      // Pretend the click happened and the next hook firing returned a
      // partial payload — this is the steady state the editor lives in
      // once the operator opted into the slice.
      fileQueryFixture = {
        data: {
          ok: true,
          partial: true,
          content: "first 64K of bytes",
          sha: "deadbeef",
          mtime: 0,
          totalSize: 12 * 1024 * 1024,
          range: { offset: 0, length: LARGE_FILE_PARTIAL_BYTES },
          encoding: "utf-8",
        },
        error: null,
        isLoading: false,
      };

      renderEditor();

      // The banner is rendered above the editor.
      const banner = await screen.findByTestId("large-file-partial-banner");
      expect(banner).toHaveAttribute(
        "data-shown-bytes",
        String(LARGE_FILE_PARTIAL_BYTES),
      );
      expect(banner).toHaveAttribute(
        "data-total-bytes",
        String(12 * 1024 * 1024),
      );
      expect(banner.textContent).toContain("Showing partial content");
      expect(banner.textContent).toContain("64 KB");
      expect(banner.textContent).toContain("12 MB");
      expect(banner.textContent).toContain("Read-only");

      // The editor wrapper exposes a `data-partial="true"` flag via
      // `code-editor` so other UI (e.g. tab indicators) can branch on
      // it without re-deriving from the response shape.
      const editor = await screen.findByTestId("code-editor");
      expect(editor).toHaveAttribute("data-partial", "true");
    },
  );

  it(
    "Cmd+S_in_partial_mode_fires_saving_disabled_toast",
    async () => {
      // Same partial payload as above — the editor mounts with
      // `partial`, registers the Cmd+S command on its Monaco surface,
      // and the simulated chord triggers the toast.
      fileQueryFixture = {
        data: {
          ok: true,
          partial: true,
          content: "first 64K of bytes",
          sha: "deadbeef",
          mtime: 0,
          totalSize: 12 * 1024 * 1024,
          range: { offset: 0, length: LARGE_FILE_PARTIAL_BYTES },
          encoding: "utf-8",
        },
        error: null,
        isLoading: false,
      };

      renderEditor();

      // Wait for the Monaco mock to flush its onMount effect.
      await screen.findByTestId("mock-monaco");

      // Confirm the partial-mode handler registered.
      expect(registeredCommands).toHaveLength(1);

      await act(async () => {
        registeredCommands[0]?.handler();
      });

      const toast = await screen.findByTestId("code-mode-toast");
      expect(toast.textContent).toContain("Saving disabled on partial open");
    },
  );
});
