import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./CodeEditor.lazy";

// `React.lazy` is the contract that lets the bundler split Monaco into its
// own chunk. The post-build assertion in slice 00's verify command (`grep
// -i monaco dist/assets`) catches any regression that drags Monaco back
// into the main bundle.
const CodeEditorInner = lazy(() => import("./CodeEditor.lazy"));

function EditorSkeleton({ height }: { height?: string | number }) {
  // Plain block matched to `height` so the surrounding layout doesn't
  // jump as Monaco hydrates. Tailwind's `bg-muted` gives us the same neutral
  // surface used elsewhere in the app for pending content.
  const resolvedHeight = typeof height === "number" ? `${height}px` : height ?? "100%";
  return (
    <div
      className="w-full h-full animate-pulse rounded-md bg-muted"
      style={{ height: resolvedHeight, minHeight: 80 }}
      data-testid="code-editor-skeleton"
      aria-busy="true"
      aria-label="Loading editor"
    />
  );
}

/**
 * Theme-aware Monaco wrapper.
 *
 * The Monaco runtime is expensive (~1MB gzipped) so this component is the
 * only entry point — `CodeEditor.lazy.tsx` does the actual import and lives
 * behind `React.lazy` so the bundler can ship Monaco as a standalone chunk.
 *
 * Props mirror the inner component but the import surface stays cheap: a
 * caller that *might* render an editor (a tab that's not active yet, a
 * conditional file picker) doesn't pay for Monaco until it actually mounts.
 *
 * See `CodeEditor.lazy.tsx` for the language/theme/diff logic.
 */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<EditorSkeleton height={props.height} />}>
      <CodeEditorInner {...props} />
    </Suspense>
  );
}

export type { CodeEditorProps } from "./CodeEditor.lazy";
