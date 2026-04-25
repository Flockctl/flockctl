#!/usr/bin/env tsx
/**
 * Harness smoke test — proves the end-to-end cli-docker loop works.
 *
 * This is the single checkpoint that the harness is healthy before we fan
 * out to full CLI command coverage. Assertions:
 *
 *   1. `flockctl --version` prints something matching /^\d+\.\d+\.\d+/.
 *   2. `flockctl start` returns exit 0 and `flockctl status` reports `running`.
 *   3. GET /health from inside the container returns 200.
 *   4. `flockctl stop` returns exit 0.
 *   5. After cleanup, a coverage-final.json under
 *      coverage/cli-docker/<containerName>/ exists on the host and includes
 *      an entry for dist/cli.js (or src/cli.ts when source maps are enabled).
 *
 * If this test fails, do NOT proceed to the per-command slices — fix the
 * harness first.
 *
 * Verification:
 *   npm run test:cli-docker -- --grep harness-smoke
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, withCliDocker } from "./_harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const hostCoverageRoot = resolve(repoRoot, "coverage", "cli-docker");

function walkForCoverage(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(p);
      } else if (name === "coverage-final.json") {
        out.push(p);
      }
    }
  }
  return out;
}

let capturedContainerName = "";

await withCliDocker(async (ctx) => {
  capturedContainerName = ctx.containerName;

  // 1. `flockctl --version`
  const version = await ctx.exec(["--version"], { timeoutMs: 15_000 });
  assert(
    version.code === 0,
    `flockctl --version should exit 0, got ${version.code}; stderr=${version.stderr}`,
  );
  assert(
    /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
    `--version output should match /^\\d+\\.\\d+\\.\\d+/, got ${JSON.stringify(
      version.stdout,
    )}`,
  );

  // 2a. `flockctl start` — returns exit 0 after the detached daemon signals ready.
  // Bind to 0.0.0.0 so docker's host port mapping can reach the daemon; the
  // container is already isolated on 127.0.0.1:<hostPort>:52077 at the host
  // level, so --allow-insecure-public here is safe (and required to skip the
  // "no token set" guard that normally protects non-loopback binds).
  const start = await ctx.exec(
    ["start", "--host", "0.0.0.0", "--allow-insecure-public"],
    { timeoutMs: 30_000 },
  );
  assert(
    start.code === 0,
    `flockctl start should exit 0, got ${start.code}; stderr=${start.stderr}`,
  );

  // Make sure the daemon is actually serving before we probe /health — the
  // CLI exits as soon as the child signals ready, but the child may still be
  // finishing migrations / cron wiring right after.
  await ctx.waitForDaemon();

  // 2b. `flockctl status` — should report running now.
  const status = await ctx.exec(["status"], { timeoutMs: 15_000 });
  assert(
    status.code === 0,
    `flockctl status should exit 0, got ${status.code}; stderr=${status.stderr}`,
  );
  assert(
    /running/i.test(status.stdout),
    `flockctl status should mention "running", got ${JSON.stringify(status.stdout)}`,
  );

  // 3. GET /health from inside the container (separate from the host probe
  // done by waitForDaemon — this asserts the container-local loopback path
  // works, which is the one end users on a remote daemon will hit).
  // Alpine's busybox wget returns non-zero on non-2xx responses, so exit 0
  // here implies 200.
  const health = await ctx.exec(
    ["sh", "-c", "wget -q -O - http://127.0.0.1:52077/health"],
    { raw: true, timeoutMs: 10_000 },
  );
  assert(
    health.code === 0,
    `GET /health from inside container should exit 0, got ${health.code}; stderr=${health.stderr}`,
  );
  assert(
    /"status"\s*:\s*"ok"/.test(health.stdout),
    `/health body should report status=ok, got ${JSON.stringify(health.stdout)}`,
  );

  // 4. `flockctl stop`
  const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
  assert(
    stop.code === 0,
    `flockctl stop should exit 0, got ${stop.code}; stderr=${stop.stderr}`,
  );
});

// 5. After withCliDocker's finally block, per-container coverage has been
// copied to coverage/cli-docker/<containerName>/. Walk it and confirm at
// least one coverage-final.json mentions the CLI entry point.
assert(
  capturedContainerName.length > 0,
  "internal: containerName was never captured from withCliDocker context",
);

const destDir = join(hostCoverageRoot, capturedContainerName);
assert(
  existsSync(destDir),
  `expected per-container coverage dir ${destDir} to exist after cleanup`,
);

const covFiles = walkForCoverage(destDir);
assert(
  covFiles.length > 0,
  `expected at least one coverage-final.json under ${destDir}, found none`,
);

let foundCli = false;
let sawKeys: string[] = [];
for (const f of covFiles) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  } catch {
    continue;
  }
  for (const k of Object.keys(parsed)) {
    sawKeys.push(k);
    if (k.endsWith("dist/cli.js") || k.endsWith("src/cli.ts")) {
      foundCli = true;
      break;
    }
  }
  if (foundCli) break;
}
assert(
  foundCli,
  `no coverage-final.json under ${destDir} contains an entry for dist/cli.js or src/cli.ts. Saw keys: ${JSON.stringify(
    sawKeys.slice(0, 20),
  )}`,
);

console.log("harness-smoke: ok");
