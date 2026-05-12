import { useState } from "react";
import { CodeEditor } from "@/components/CodeEditor";

const SAMPLE = `// CodeEditor preview — slice 00.
//
// This page exists so the Monaco wrapper has at least one reachable
// consumer in the bundle graph. Without it, vite would tree-shake
// CodeEditor.tsx out and the lazy "monaco" chunk would never emit.
// Slice 01 replaces this preview with the real Code-mode editor area;
// at that point this file can disappear.

export function add(a: number, b: number) {
  return a + b;
}
`;

/**
 * Standalone preview of the {@link CodeEditor} wrapper. Mounted at
 * `/dev/code-editor-preview` — not part of the navigation, but reachable
 * so that:
 *
 * 1. operators can sanity-check the editor in isolation while we wire it
 *    up across the app;
 * 2. vite keeps the lazy Monaco chunk in the build (`dist/assets/monaco-*.js`).
 */
export default function DevCodeEditorPreviewPage() {
  const [value, setValue] = useState(SAMPLE);

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="text-sm text-muted-foreground">
        CodeEditor preview — edits here are local only.
      </div>
      <div className="flex-1 min-h-[400px] rounded-md border">
        <CodeEditor
          value={value}
          onChange={setValue}
          path="preview.ts"
          height="100%"
        />
      </div>
    </div>
  );
}
