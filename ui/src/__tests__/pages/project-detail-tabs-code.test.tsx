import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * M23 / T06 — Project-detail Code tab restyle contract.
 *
 * Pins down two surfaces the slice spec calls out:
 *
 *   1. **File tree row styling** — small font, zinc text, indigo-tinted
 *      hover, indigo-highlighted selected row. The row also adopts the
 *      Monaco `editor-line` rhythm (`leading-[22px]`, `text-[13px]`)
 *      so the file tree and the open editor scroll on the same baseline.
 *
 *   2. **Monaco theme contribution** — `<CodeEditor>` registers
 *      `flockctl-light` and `flockctl-dark` themes that inherit from
 *      `vs` / `vs-dark` and override `editor.background`,
 *      `editor.foreground`, and `editorLineNumber.foreground` from the
 *      semantic CSS variables (`--card`, `--foreground`,
 *      `--muted-foreground`). The themes are re-registered on each
 *      theme flip so a CSS-variable change picks the new colour up
 *      without remounting Monaco.
 *
 * Tests are intentionally split across two `describe` blocks so a
 * regression in either surface points straight at the broken contract.
 */

// --- localStorage + matchMedia shim --------------------------------------
//
// Mirrors `code-editor.test.tsx`: jsdom 29 + Node 25 ship without a usable
// `localStorage.getItem`, and `window.matchMedia` is missing entirely. The
// theme provider needs both, so install a deterministic shim per test.
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
  // The Monaco theme registration helper inspects `:root` via
  // `getComputedStyle` and a sacrificial probe element to convert
  // CSS-variable colours to hex. Pre-paint a couple of variables on
  // the document root so the helper has something well-formed to
  // canonicalise — the actual hex doesn't matter for the contract
  // (we only assert which keys the override map carries), but a
  // missing variable would land an empty string in the colour map and
  // Monaco would throw at `defineTheme` time.
  document.documentElement.style.setProperty("--card", "#ffffff");
  document.documentElement.style.setProperty("--foreground", "#111111");
  document.documentElement.style.setProperty("--muted-foreground", "#777777");
  document.documentElement.style.setProperty("--border", "#e5e5e5");
});

// --- Mocks ---------------------------------------------------------------
//
// Capture every `defineTheme` call so we can assert the wrapper
// registered both Flockctl themes with the expected base + colour map
// keys. The mock also exposes a deterministic `setTheme` so the theme
// effect's flip path can be observed.
const defineThemeCalls: Array<{
  id: string;
  data: {
    base: string;
    inherit: boolean;
    rules: unknown[];
    colors: Record<string, string>;
  };
}> = [];
const setThemeCalls: string[] = [];
const updateOptionsCalls: Array<Record<string, unknown>> = [];

vi.mock("monaco-editor", () => {
  return {
    editor: {
      defineTheme: (id: string, data: unknown) => {
        defineThemeCalls.push({
          id,
          data: data as {
            base: string;
            inherit: boolean;
            rules: unknown[];
            colors: Record<string, string>;
          },
        });
      },
      setTheme: (id: string) => {
        setThemeCalls.push(id);
      },
    },
  };
});

vi.mock("@monaco-editor/react", () => {
  // Same pattern as `code-editor.test.tsx`: fire `onMount` synchronously
  // inside `useEffect` so the wrapper's theme effect has a fake
  // instance to talk to before the test pokes the theme controller.
  const Editor = ({
    theme,
    onMount,
  }: {
    theme?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    React.useEffect(() => {
      const fakeEditor = {
        updateOptions: (opts: Record<string, unknown>) => {
          updateOptionsCalls.push(opts);
        },
      };
      onMount?.(fakeEditor, {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="mock-monaco" data-theme={theme ?? ""} />;
  };
  const DiffEditor = ({ theme }: { theme?: string }) => (
    <div data-testid="mock-monaco-diff" data-theme={theme ?? ""} />
  );
  return { Editor, DiffEditor, loader: { config: vi.fn() } };
});

// --- Subjects under test -------------------------------------------------

import { CodeEditor } from "@/components/CodeEditor";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { TreeNode } from "@/components/file-tree/TreeNode";
import { GitStatusTreeContext } from "@/components/file-tree/git-status-context";
import { TreeContextMenuContext } from "@/components/file-tree/tree-context-menu-context";
import type { FsTreeNode } from "@/components/file-tree/use-fs-tree";

/**
 * Build the minimal `NodeApi` shim react-arborist hands to a renderer.
 * We only touch the props `TreeNode` actually reads (`data`, `level`,
 * `isOpen`, `isSelected`, `toggle`, `activate`), so the cast is safe
 * for the contract under test.
 */
function makeNode(
  data: FsTreeNode,
  { isSelected = false }: { isSelected?: boolean } = {},
) {
  return {
    data,
    level: 0,
    isOpen: false,
    isSelected,
    toggle: vi.fn(),
    activate: vi.fn(),
    id: data.path,
  };
}

function renderRow(
  data: FsTreeNode,
  { isSelected = false }: { isSelected?: boolean } = {},
) {
  // `TreeNode` only consumes `node`/`style`/`dragHandle`. The other
  // props in `NodeRendererProps` are passed through by react-arborist
  // and are unused here, so cast the whole prop bag.
  const props = {
    node: makeNode(data, { isSelected }),
    style: {},
    dragHandle: () => {},
    tree: null,
    preview: false,
  } as unknown as Parameters<typeof TreeNode>[0];
  return render(
    <MemoryRouter>
      <GitStatusTreeContext.Provider value={new Map()}>
        <TreeContextMenuContext.Provider value={null}>
          <TreeNode {...props} />
        </TreeContextMenuContext.Provider>
      </GitStatusTreeContext.Provider>
    </MemoryRouter>,
  );
}

// --- Tests: file tree row styling ---------------------------------------

describe("Code tab — file tree row styling", () => {
  it("file_tree_row_uses_small_zinc_typography_aligned_to_editor_line", () => {
    renderRow({
      kind: "file",
      id: "src/index.ts",
      path: "src/index.ts",
      name: "index.ts",
      ignored: false,
    });
    const row = screen.getByTestId("file-tree-row-src/index.ts");
    // Small font + zinc text matches the prototype's editor look.
    expect(row.className).toContain("text-[13px]");
    expect(row.className).toContain("text-zinc-700");
    expect(row.className).toContain("dark:text-zinc-300");
    // 22px line-height aligns each row to a Monaco `editor-line` cell.
    expect(row.className).toContain("leading-[22px]");
  });

  it("file_tree_row_uses_indigo_tinted_hover", () => {
    renderRow({
      kind: "file",
      id: "src/index.ts",
      path: "src/index.ts",
      name: "index.ts",
      ignored: false,
    });
    const row = screen.getByTestId("file-tree-row-src/index.ts");
    // The hover state shifts to a low-alpha indigo wash so the row
    // visually ties to the indigo accent palette without competing
    // with the selected-row highlight.
    expect(row.className).toContain("hover:bg-indigo-500/5");
  });

  it("file_tree_row_highlights_selected_with_indigo_palette", () => {
    renderRow(
      {
        kind: "file",
        id: "src/index.ts",
        path: "src/index.ts",
        name: "index.ts",
        ignored: false,
      },
      { isSelected: true },
    );
    const row = screen.getByTestId("file-tree-row-src/index.ts");
    expect(row.getAttribute("data-selected")).toBe("true");
    expect(row.className).toContain("bg-indigo-500/10");
    expect(row.className).toContain("text-indigo-700");
    expect(row.className).toContain("dark:text-indigo-300");
    expect(row.className).toContain("font-medium");
    // The previous shadcn-accent palette MUST NOT remain on selected
    // rows — it competes visually with the indigo highlight and is the
    // exact "old shell" the slice replaces.
    expect(row.className).not.toContain("bg-accent text-accent-foreground");
  });

  it("file_tree_row_keeps_dim_treatment_for_gitignored_paths", () => {
    renderRow({
      kind: "file",
      id: "node_modules/foo.js",
      path: "node_modules/foo.js",
      name: "foo.js",
      ignored: true,
    });
    const row = screen.getByTestId("file-tree-row-node_modules/foo.js");
    expect(row.getAttribute("data-ignored")).toBe("true");
    expect(row.className).toContain("opacity-50");
  });
});

// --- Tests: Monaco theme contribution -----------------------------------

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

describe("Code tab — Monaco theme contribution", () => {
  beforeEach(() => {
    defineThemeCalls.length = 0;
    setThemeCalls.length = 0;
    updateOptionsCalls.length = 0;
  });

  it("registers_flockctl_light_and_dark_themes_with_palette_overrides", async () => {
    render(
      <ThemeProvider>
        <CodeEditor value="hello" />
      </ThemeProvider>,
    );

    // Wait for the lazy chunk to settle and the editor to mount.
    await screen.findByTestId("mock-monaco");

    // Both themes must have been registered. We assert by id; the
    // registration helper is also called once at module load and again
    // on every mount, so `length` is not part of the contract — the
    // presence of both ids is.
    const ids = defineThemeCalls.map((c) => c.id);
    expect(ids).toContain("flockctl-light");
    expect(ids).toContain("flockctl-dark");

    const dark = defineThemeCalls.find((c) => c.id === "flockctl-dark")!;
    const light = defineThemeCalls.find((c) => c.id === "flockctl-light")!;

    // `inherit: true` keeps the stock `vs` / `vs-dark` token theme so
    // we don't fork the syntax highlighter.
    expect(dark.data.base).toBe("vs-dark");
    expect(dark.data.inherit).toBe(true);
    expect(light.data.base).toBe("vs");
    expect(light.data.inherit).toBe(true);

    // The slice scope only requires the three structural overrides
    // (background, foreground, line-number colour). Assert they are
    // present in both themes; the specific hex values come from the
    // `:root` CSS variables seeded in `beforeEach`.
    for (const theme of [dark, light]) {
      expect(Object.keys(theme.data.colors)).toEqual(
        expect.arrayContaining([
          "editor.background",
          "editor.foreground",
          "editorLineNumber.foreground",
        ]),
      );
      // The override map must hold concrete `#rrggbb` strings — Monaco
      // rejects CSS variables and would silently fall back to the
      // base theme colour otherwise.
      expect(theme.data.colors["editor.background"]).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
      expect(theme.data.colors["editor.foreground"]).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
      expect(theme.data.colors["editorLineNumber.foreground"]).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
    }
  });

  it("re_registers_themes_and_flips_setTheme_when_the_provider_toggles", async () => {
    render(
      <ThemeProvider>
        <CodeEditor value="x" onChange={() => {}} />
        <ThemeController />
      </ThemeProvider>,
    );
    await screen.findByTestId("mock-monaco");

    // Lock the starting palette to light so the assertion below is
    // independent of `prefers-color-scheme`.
    await act(async () => {
      screen.getByTestId("theme-light").click();
    });
    const beforeFlip = defineThemeCalls.length;

    // Toggle to dark — the effect must (a) re-register both themes
    // against the (now possibly different) CSS variables and (b) call
    // `setTheme('flockctl-dark')` so the live editor flips.
    await act(async () => {
      screen.getByTestId("theme-dark").click();
    });
    expect(defineThemeCalls.length).toBeGreaterThan(beforeFlip);
    expect(setThemeCalls).toContain("flockctl-dark");
    // Standalone editor's `updateOptions` route also gets the new id.
    expect(updateOptionsCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ theme: "flockctl-dark" }),
      ]),
    );
    expect(screen.getByTestId("mock-monaco").getAttribute("data-theme")).toBe(
      "flockctl-dark",
    );

    // …and back the other way uses the same code path.
    await act(async () => {
      screen.getByTestId("theme-light").click();
    });
    expect(setThemeCalls).toContain("flockctl-light");
  });
});
