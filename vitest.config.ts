import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/cli.ts",
        "src/cli-commands/**",
        "src/server-entry.ts",
        "src/daemon.ts",
        "src/db/migrate.ts",
        "src/db/config-backfill.ts",
        "src/db/schema.ts",
        "src/bundled-skills/**",
        "src/**/*.d.ts",
      ],
      // Thresholds enforce the 95% floor requested during the April-2026
      // coverage push. Measured levels are higher (statements ~98, branches
      // ~96, functions ~98, lines ~99); keep a small buffer below so the
      // suite doesn't flake on off-by-one coverage fluctuations. Raise these
      // whenever a batch of tests lands that permanently lifts a metric.
      thresholds: {
        statements: 95,
        lines: 95,
        branches: 95,
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
