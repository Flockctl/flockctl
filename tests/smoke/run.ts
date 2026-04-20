/**
 * Smoke test runner — executes each test-*.ts file in its own tsx process.
 *
 * Each smoke test starts a real server-entry.ts on a temporary port with an
 * isolated FLOCKCTL_HOME, makes one or more HTTP calls, asserts, and exits.
 * Failures bubble up as non-zero exit codes; the runner aggregates and reports.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

if (files.length === 0) {
  console.error("No smoke tests found in tests/smoke/");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log(`Running ${files.length} smoke test(s)...\n`);

for (const file of files) {
  const full = join(here, file);
  const label = file.replace(/^test-/, "").replace(/\.ts$/, "");
  process.stdout.write(`  ${label} ... `);
  const start = Date.now();
  const result = spawnSync("npx", ["tsx", full], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  const ms = Date.now() - start;
  if (result.status === 0) {
    passed += 1;
    console.log(`ok (${ms}ms)`);
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
