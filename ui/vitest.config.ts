import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
