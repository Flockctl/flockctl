import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/cli.ts",
        "src/server-entry.ts",
        "src/daemon.ts",
        "src/db/migrate.ts",
        "src/db/config-backfill.ts",
        "src/db/schema.ts",
        "src/bundled-skills/**",
        "src/**/*.d.ts",
      ],
      thresholds: {
        statements: 96,
        lines: 98,
        branches: 85,
        functions: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
