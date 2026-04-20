/**
 * Live test runner — mirrors tests/smoke/run.ts but gated by
 * FLOCKCTL_LIVE_TESTS=1. Live tests make real calls to Anthropic / OpenAI /
 * Claude CLI, so they are NOT part of CI by default.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.FLOCKCTL_LIVE_TESTS !== "1") {
  console.log("Skipping live tests (set FLOCKCTL_LIVE_TESTS=1 to enable).");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

if (files.length === 0) {
  console.error("No live tests found in tests/live/");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log(`Running ${files.length} live test(s)...\n`);

for (const file of files) {
  const full = join(here, file);
  const label = file.replace(/^test-/, "").replace(/\.ts$/, "");
  process.stdout.write(`  ${label} ... `);
  const start = Date.now();
  const result = spawnSync("npx", ["tsx", full], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  const ms = Date.now() - start;
  if (result.status === 0) {
    passed += 1;
    console.log(`ok (${ms}ms)`);
  } else if (result.status === 77) {
    // Convention: exit 77 = skipped (missing API key, CLI not installed, etc.)
    console.log(`skipped (${ms}ms)`);
    if (result.stdout) process.stdout.write(result.stdout);
  } else {
    failed += 1;
    failures.push(file);
    console.log(`FAIL (${ms}ms, exit ${result.status ?? "?"})`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failed:", failures.join(", "));
  process.exit(1);
}
