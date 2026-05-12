import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Project root. Keep first so `@/__tests__/...` still wins.
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // `monaco-editor`'s ESM bundle is too deep for vitest's vite to load
      // in jsdom — pull every importer onto a tiny stub. Per-test
      // `vi.mock("@monaco-editor/react", …)` and
      // `vi.mock("monaco-editor/esm/vs/editor/editor.api", …)` continue to
      // win over this alias when they want to assert on Monaco's surface.
      //
      // The `?worker` query is Vite's build-time directive — vitest doesn't
      // synthesize a Worker factory in jsdom, so we redirect each language
      // worker import onto the stub class.
      {
        find: /^monaco-editor\/esm\/vs\/.*\.worker(?:\?worker)?$/,
        replacement: path.resolve(__dirname, "./src/__tests__/__mocks__/monaco-worker.ts"),
      },
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(__dirname, "./src/__tests__/__mocks__/monaco-editor.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    // Keep the API base URL empty in tests so fetch-call assertions can
    // compare against plain paths like `/mcp/projects/42/...` regardless of
    // whether the code under test is using apiFetch or a raw fetch.
    env: { VITE_API_URL: "" },
  },
});
