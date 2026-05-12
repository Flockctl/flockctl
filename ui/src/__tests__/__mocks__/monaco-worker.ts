/**
 * Vitest stub for `monaco-editor/esm/vs/editor/editor.worker?worker` and the
 * sibling language-worker `?worker` imports. Vite's `?worker` query is a
 * build-time directive; vitest's transformer doesn't synthesize a Worker
 * factory in jsdom, so the bare URL fails to resolve.
 *
 * The stub returns a no-op constructor matching the `new Worker()` shape
 * expected by `CodeEditor.lazy.tsx`'s `MonacoEnvironment.getWorker`. Tests
 * never spawn a real worker — Monaco itself is mocked at `@monaco-editor/react`
 * level — so the constructor only needs to type-check.
 */

class StubWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

export default StubWorker;
