/**
 * Vitest stub for the bare `monaco-editor` package.
 *
 * `CodeEditor.lazy.tsx` does `import * as monaco from "monaco-editor"` (the
 * full ESM bundle, not the `editor.api` entry). That bundle has hundreds of
 * deeply-nested files with circular imports that vitest's vite resolver
 * can't load in a jsdom environment — every test that touches the lazy
 * editor module would otherwise fail with `Failed to resolve import
 * "monaco-editor"`.
 *
 * This stub provides only the surface area the wrapper module touches at
 * import time: `editor.defineTheme` (called once on module load to register
 * the Flockctl themes) and `editor.setTheme` (called by the theme-flip
 * effect). Every per-test mock continues to work — vi.mock wins over the
 * vitest.config alias.
 */

const noop = (..._args: unknown[]): undefined => undefined;

export const editor = {
  defineTheme: noop,
  setTheme: noop,
  // Supplying these shells lets the wrapper module evaluate without
  // accessing undefined fields on the namespace; per-test `vi.mock` blocks
  // override them with spy-friendly versions when assertions are needed.
  create: noop,
  createDiffEditor: noop,
};

export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
  file: (s: string) => ({ toString: () => s }),
};

// `monaco.Environment` is only used as a TYPE in the source, but vitest
// still tries to evaluate the namespace value. Export an empty object to
// satisfy structural lookups.
export const Environment = {};

export default { editor, Uri, Environment };
