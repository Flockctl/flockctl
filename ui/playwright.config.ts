import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
const frontendPort = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
const e2eHome = resolve(repoRoot, ".e2e-data");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  // Keep visual baselines next to the spec that produced them — Playwright's
  // default nests each screenshot under `<spec>-snapshots/`, which gets noisy
  // when multiple specs ship baselines. Routing all screenshots through a
  // single `__screenshots__` tree (grouped by spec file) keeps the diff small
  // and matches the layout the tests assume on disk.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `npx tsx src/server-entry.ts --port ${backendPort}`,
      cwd: repoRoot,
      env: {
        FLOCKCTL_HOME: e2eHome,
        FLOCKCTL_MOCK_AI: "1",
      },
      port: backendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
    {
      command: `npm run dev -- --port ${frontendPort}`,
      cwd: here,
      env: {
        VITE_API_TARGET: `http://localhost:${backendPort}`,
      },
      port: frontendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
  ],
});
