import { useEffect, useMemo, useRef, type CSSProperties } from "react";
// Import the bare `monaco-editor` package, NOT `monaco-editor/esm/vs/editor/
// editor.api`. The `.api` entry is core editor + standalone API only — it
// registers exactly one language (`plaintext`) and nothing else. The first
// time someone opened a `.json`, `.md`, `.ts`, … file, Monaco's
// `_createModelData` looked up the language factory by id, got `undefined`,
// and crashed the React Router error boundary with
// `n.create is not a function. (In 'n.create(t)', 'n.create' is undefined)`
// — surfaced from `createTextBuffer(value, defaultEOL)` deep inside
// `createModel`.
//
// The bare package import resolves via `package.json`'s `module` field to
// `esm/vs/editor/editor.main.js`, which pulls in `basic-languages` and the
// `language/{css,html,json,typescript}` contributions on top of the core
// API. Types come via the package's `typings` field (still pointing at
// `editor.api.d.ts`) — the runtime surface is a strict superset of the
// typed surface, so this is sound.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  DiffEditor,
  Editor,
  loader,
  type OnMount,
} from "@monaco-editor/react";
import { useTheme } from "./theme-provider";
import { LargeFilePartialBanner } from "./code-mode/LargeFileBanner";

// `@monaco-editor/react` defaults to fetching Monaco from a CDN. That is a
// non-starter on remote daemons (no internet, or worse, a captive portal that
// answers HTML). Hand it the bundled copy we already imported above so the
// editor boots offline. Calling `loader.config` at module scope is safe —
// the loader caches the registration and ignores subsequent calls.
loader.config({ monaco });

// Wire dedicated web workers per language. Without this, Monaco falls back
// to a same-thread "simple worker" host that prints noisy "Could not create
// web worker" warnings on every JSON/TS/CSS file open and silently degrades
// validation + formatting. The `?worker` query is Vite's worker-import
// syntax — it bundles each `.worker.js` as a separate Web Worker chunk and
// returns a constructor, exactly like Monaco's official Vite recipe.
//
// Casting to `unknown` first because `self` in the SPA is the `Window`,
// which doesn't carry the `MonacoEnvironment` field on its lib.dom typing
// — TypeScript treats it as a structural augmentation that monaco-editor
// ships internally. The runtime shape is what matters; lib.dom catching
// up is irrelevant.
type WorkerCtor = new () => Worker;
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  {
    getWorker(_workerId: string, label: string): Worker {
      const Ctor: WorkerCtor =
        label === "json"
          ? (JsonWorker as unknown as WorkerCtor)
          : label === "css" || label === "scss" || label === "less"
            ? (CssWorker as unknown as WorkerCtor)
            : label === "html" || label === "handlebars" || label === "razor"
              ? (HtmlWorker as unknown as WorkerCtor)
              : label === "typescript" || label === "javascript"
                ? (TsWorker as unknown as WorkerCtor)
                : (EditorWorker as unknown as WorkerCtor);
      return new Ctor();
    },
  };

// --- Language inference ---
//
// Monaco ships its own `languages.getLanguages()` registry, but resolving an
// extension to a language id requires a registry walk every render and pulls
// the worker in eagerly. The extension map below covers the top languages a
// Flockctl user is likely to see (markdown, TS/JS, Python, Go, Rust, infra
// formats, …) and falls back to `plaintext` for anything we don't recognise.
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  lock: "yaml",
  env: "ini",
  ini: "ini",
};

function inferLanguageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  // Treat the filename's last extension as authoritative; ignore directories.
  const base = path.split("/").pop() ?? path;
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) return undefined;
  const ext = base.slice(lastDot + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext];
}

// --- Theme resolution ---
//
// The provider exposes `'light' | 'dark' | 'system'`. Monaco only knows about
// concrete themes, so collapse `system` against the OS media query. `system`
// itself does not re-render this component, but the provider already mutates
// the document root class on change, so anything mounted after a flip reads
// the right value.
//
// We then layer our own `flockctl-light` / `flockctl-dark` themes ON TOP of
// `vs` / `vs-dark` (`inherit: true`) so token colours come from the stock
// theme but the chrome — editor background, foreground, line-number gutter —
// reads from the same CSS variables the rest of the app uses. This keeps the
// Monaco surface visually flush with the surrounding `<FlatCard>` shell
// without forking the syntax theme (a future milestone owns that).
export type FlockctlMonacoTheme = "flockctl-light" | "flockctl-dark";

function resolveMonacoTheme(
  theme: "light" | "dark" | "system",
): FlockctlMonacoTheme {
  if (theme === "dark") return "flockctl-dark";
  if (theme === "light") return "flockctl-light";
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "flockctl-dark"
      : "flockctl-light";
  }
  return "flockctl-light";
}

/**
 * Read a CSS custom property off `:root` and resolve it to a `#rrggbb`
 * Monaco-compatible colour. The variables in this codebase ship as
 * `hsl(...)` triplets, but Monaco's theme contribution accepts only
 * canonical hex strings — so we hand the raw value to a sacrificial
 * `<span>`, let the browser do the resolution + canonicalisation via
 * `getComputedStyle`, and convert the resulting `rgb(...)` string back
 * to hex.
 *
 * Defensive against missing variables (returns `#000000`) and the SSR
 * / jsdom case where the layout engine cannot resolve colours
 * (returns `#000000` so the caller's options are still well-formed).
 */
function hexFromCssVar(name: string, fallback = "#000000"): string {
  if (typeof document === "undefined") return fallback;
  // Pull the raw value off :root first — most Monaco mounts only
  // happen client-side, so the cost of one `getComputedStyle` call per
  // theme registration is negligible.
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  // Round-trip through a detached element to canonicalise whatever
  // colour function the variable holds (`hsl(...)`, `oklch(...)`,
  // named, hex) into the always-`rgb(...)` representation
  // `getComputedStyle` returns. The element is never attached to the
  // DOM, so it costs no layout.
  const probe = document.createElement("span");
  probe.style.color = raw;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const match = computed.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/,
  );
  if (!match || !match[1] || !match[2] || !match[3]) return fallback;
  const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

/**
 * Register (or re-register) the Flockctl Monaco themes. Calling
 * `defineTheme` with the same id is the supported way to update an
 * existing theme — Monaco swaps the colour map atomically and every
 * mounted editor picks the new palette up on the next `setTheme`
 * call.
 *
 * Exported so tests can assert the themes exist on the registry, and
 * so the Code-tab e2e baseline can re-define after a CSS-variable
 * mutation without needing to remount the editor.
 */
export function registerFlockctlMonacoThemes(): void {
  const card = hexFromCssVar("--card");
  const foreground = hexFromCssVar("--foreground");
  const muted = hexFromCssVar("--muted-foreground");
  const border = hexFromCssVar("--border");

  monaco.editor.defineTheme("flockctl-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": card,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": foreground,
      "editorIndentGuide.background": border,
    },
  });
  monaco.editor.defineTheme("flockctl-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": card,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": foreground,
      "editorIndentGuide.background": border,
    },
  });
}

// Define both themes once at module load so the very first editor
// mount has them on the registry. Subsequent re-registers happen via
// the `useEffect` below whenever the active theme flips.
registerFlockctlMonacoThemes();

// --- Public props ---

export interface CodeEditorProps {
  value: string;
  /** Omit to render a read-only editor. */
  onChange?: (next: string) => void;
  /** Explicit Monaco language id. If omitted, inferred from `path`. */
  language?: string;
  /** Used both for language inference and as the Monaco model URI. */
  path?: string;
  /** Defaults to `'100%'`. */
  height?: string | number;
  /** When set, render a side-by-side diff editor with `value` as the modified buffer. */
  diff?: { original: string };
  className?: string;
  /** Test hook — invoked after the editor has mounted with the live instance. */
  onMount?: OnMount;
  /**
   * When provided, the editor is rendering a partial slice of a larger
   * file. Triggers two behaviour shifts: (1) the read-only Monaco mode
   * is forced regardless of `onChange` so a stray edit cannot reach the
   * disk via Cmd+S, and (2) a {@link LargeFilePartialBanner} is mounted
   * above the editor advertising the slice + denominator. `shownBytes`
   * is the slice actually returned by the server (may be ≤ what was
   * requested when the offset is near EOF); `totalBytes` is the whole-
   * file size used as the "you're 0.4% in" denominator.
   */
  partial?: { totalBytes: number; shownBytes: number };
}

// --- Implementation ---

/**
 * Inner Monaco renderer. Lazy-loaded via `React.lazy` from `CodeEditor.tsx`
 * so the heavy `monaco-editor` import only lands once a caller actually
 * mounts the component.
 */
export default function CodeEditorInner({
  value,
  onChange,
  language,
  path,
  height = "100%",
  diff,
  className,
  onMount,
  partial,
}: CodeEditorProps) {
  const { theme } = useTheme();
  const monacoTheme = useMemo(() => resolveMonacoTheme(theme), [theme]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const resolvedLanguage = useMemo(
    () => language ?? inferLanguageFromPath(path) ?? "plaintext",
    [language, path],
  );

  // `partial` forces read-only regardless of `onChange` — saving a slice
  // would silently truncate the rest of the file on disk. Surfacing this
  // as a Monaco-level invariant (rather than a parent-side guard) means a
  // future caller that hands us `onChange` for a partial view still gets
  // the safe behaviour for free.
  const readOnly = onChange === undefined || partial !== undefined;

  // Push theme changes through `updateOptions` instead of remounting — the
  // diff editor in particular is expensive to rebuild and a remount would
  // discard scroll/selection state. Both standalone and diff editors expose
  // `updateOptions({ theme })`.
  //
  // Before flipping, we re-register the Flockctl themes against the current
  // CSS variables. The provider toggles `.dark` on `<html>` *first*, then the
  // value of `theme` propagates here on the next render — so by the time
  // this effect runs, `getComputedStyle` sees the new palette and the
  // re-registration burns the right colours into the Monaco theme map.
  useEffect(() => {
    registerFlockctlMonacoThemes();
    if (editorRef.current) {
      // `theme` lives on `IGlobalEditorOptions`, which is mixed into the
      // standalone editor's options interface.
      editorRef.current.updateOptions({ theme: monacoTheme });
    }
    // The diff editor's options interface (`IDiffEditorOptions`) does NOT
    // expose `theme` directly — it picks the palette up from the global
    // monaco theme. `monaco.editor.setTheme` is the supported way to flip
    // every live editor (standalone + diff) at once and also propagates to
    // peek widgets, hover tooltips, etc.
    monaco.editor.setTheme(monacoTheme);
  }, [monacoTheme]);

  const commonOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
    readOnly,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontSize: 13,
    tabSize: 2,
    renderLineHighlight: "line",
    fixedOverflowWidgets: true,
  };

  // The outer wrapper MUST own a concrete height — `<Editor>` from
  // `@monaco-editor/react` resolves its `height="100%"` against its
  // immediate DOM parent. Without an explicit height here the parent
  // collapses to `auto = 0` (banner-only or empty) and the editor
  // mounts but renders invisible. We honour the caller's `height`
  // prop verbatim (string passes through, number gets `px`); the
  // wrapper is also a flex column so the partial banner sits above a
  // height-resolving editor area instead of stealing the whole parent.
  const wrapperStyle: CSSProperties = {
    height: typeof height === "number" ? `${height}px` : height,
  };
  const wrapperClass = ["flex w-full flex-col", className]
    .filter(Boolean)
    .join(" ");

  if (diff) {
    return (
      <div
        className={wrapperClass}
        style={wrapperStyle}
        data-monaco-theme={monacoTheme}
        data-testid="code-editor-diff"
      >
        <DiffEditor
          height="100%"
          theme={monacoTheme}
          language={resolvedLanguage}
          original={diff.original}
          modified={value}
          options={{ ...commonOptions, readOnly: true }}
          onMount={(editor, m) => {
            // Hand the *modified* side back to the caller — it's the only
            // editor surface where save/dirty state is meaningful.
            onMount?.(editor.getModifiedEditor(), m);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={wrapperClass}
      style={wrapperStyle}
      data-monaco-theme={monacoTheme}
      data-testid="code-editor"
      data-partial={partial ? "true" : "false"}
    >
      {partial && (
        <LargeFilePartialBanner
          shownBytes={partial.shownBytes}
          totalBytes={partial.totalBytes}
        />
      )}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          theme={monacoTheme}
          language={resolvedLanguage}
          path={path}
          value={value}
          options={commonOptions}
          onChange={(next) => onChange?.(next ?? "")}
          onMount={(editor, m) => {
            editorRef.current = editor;
            onMount?.(editor, m);
          }}
        />
      </div>
    </div>
  );
}
