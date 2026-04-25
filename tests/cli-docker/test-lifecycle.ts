#!/usr/bin/env tsx
/**
 * Lifecycle tests for `flockctl start` / `stop` / `status`.
 *
 * Seven independent cases, each wrapped in its own `withCliDocker` so a
 * lingering daemon or a mutated ~/.flockctlrc from one case cannot leak
 * into the next. Cases:
 *
 *   1. Default start — `flockctl start` → exit 0, `/health` 200 inside
 *      the container, `status` reports running, `stop` exits 0.
 *   2. Custom port — `flockctl start -p 8080` → `/health` on 8080 returns
 *      200 (probed from inside the container; only 52077 is published).
 *   3. Status when not running — pre-start `status` → "not running", exit 0.
 *   4. Stale PID file — bogus pid at /flockctl-home/flockctl.pid →
 *      `status` reports "not running" AND removes the stale file.
 *   5. Public-host refusal — `start --host 0.0.0.0` without a token →
 *      exit 1 and the security-gate message mentioning
 *      `--allow-insecure-public` appears in stderr or the daemon log.
 *   6. Public-host break-glass — same plus `--allow-insecure-public` →
 *      exit 0 and `[SECURITY WARNING]` in the log.
 *   7. Public-host with token — seed ~/.flockctlrc, `start --host 0.0.0.0`
 *      → exit 0 and log mentions "token auth active".
 *
 * Each case inspects stdout/stderr/exit code from the CLI invocation AND
 * `/flockctl-home/flockctl.log` (the daemon log — note: the container's
 * FLOCKCTL_HOME is /flockctl-home, so that's where flockctl.log /
 * flockctl.pid live, NOT ~/flockctl/).
 *
 * Verification:
 *   npm run test:cli-docker -- --grep lifecycle
 */
import { assert, withCliDocker, type CliDockerContext } from "./_harness.js";

const FLOCKCTL_HOME = "/flockctl-home";
const LOG_PATH = `${FLOCKCTL_HOME}/flockctl.log`;
const PID_PATH = `${FLOCKCTL_HOME}/flockctl.pid`;
// The rc file lives at $HOME/.flockctlrc. The container runs as root
// (no USER directive in tests/cli-docker/Dockerfile) so HOME=/root.
const RC_PATH = "/root/.flockctlrc";

/** Read the daemon log file, returning an empty string if it doesn't exist. */
async function readLog(ctx: CliDockerContext): Promise<string> {
  const r = await ctx.exec(
    ["sh", "-c", `cat ${LOG_PATH} 2>/dev/null || true`],
    { raw: true, timeoutMs: 5_000 },
  );
  return r.stdout;
}

/**
 * Probe /health on the given port from INSIDE the container. Busybox wget
 * returns non-zero on non-2xx; we don't have curl in the image. We
 * deliberately do NOT use ctx.waitForDaemon() here because that hits the
 * host-mapped port, and when the daemon binds to 127.0.0.1 (the default)
 * or to a port other than 52077, docker's port mapping won't reach it.
 */
async function fetchHealthInside(
  ctx: CliDockerContext,
  port: number,
): Promise<{ code: number; body: string }> {
  const r = await ctx.exec(
    ["sh", "-c", `wget -q -O - http://127.0.0.1:${port}/health`],
    { raw: true, timeoutMs: 10_000 },
  );
  return { code: r.code, body: r.stdout };
}

/** Poll /health inside the container until 200 or timeout. */
async function waitForHealthInside(
  ctx: CliDockerContext,
  port: number,
  timeoutMs = 15_000,
): Promise<{ code: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = { code: -1, body: "" };
  while (Date.now() < deadline) {
    last = await fetchHealthInside(ctx, port);
    if (last.code === 0 && /"status"\s*:\s*"ok"/.test(last.body)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

async function caseDefaultStartStop(): Promise<void> {
  await withCliDocker(async (ctx) => {
    const start = await ctx.exec(["start"], { timeoutMs: 30_000 });
    assert(
      start.code === 0,
      `default start should exit 0, got ${start.code}; stderr=${start.stderr}`,
    );
    assert(
      /running on|started on|http:\/\//i.test(start.stdout),
      `default start stdout should confirm the bind URL, got ${JSON.stringify(start.stdout)}`,
    );

    // Default host is 127.0.0.1 inside the container — only reachable via
    // the container-local loopback, not via the host port mapping.
    const health = await waitForHealthInside(ctx, 52077);
    assert(
      health.code === 0,
      `/health (default port, inside container) should return 200, got wget exit ${health.code}`,
    );
    assert(
      /"status"\s*:\s*"ok"/.test(health.body),
      `/health body should be status=ok, got ${JSON.stringify(health.body)}`,
    );

    const status = await ctx.exec(["status"], { timeoutMs: 15_000 });
    assert(
      status.code === 0,
      `status should exit 0, got ${status.code}; stderr=${status.stderr}`,
    );
    assert(
      /running/i.test(status.stdout) && !/not running/i.test(status.stdout),
      `status should report running, got ${JSON.stringify(status.stdout)}`,
    );

    const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
    assert(
      stop.code === 0,
      `stop should exit 0, got ${stop.code}; stderr=${stop.stderr}`,
    );
    assert(
      /stopped/i.test(stop.stdout),
      `stop should confirm termination, got ${JSON.stringify(stop.stdout)}`,
    );
  });
}

async function caseCustomPort(): Promise<void> {
  await withCliDocker(async (ctx) => {
    const start = await ctx.exec(["start", "-p", "8080"], { timeoutMs: 30_000 });
    assert(
      start.code === 0,
      `start -p 8080 should exit 0, got ${start.code}; stderr=${start.stderr}`,
    );

    const health = await waitForHealthInside(ctx, 8080);
    assert(
      health.code === 0,
      `/health on 8080 should return 200 inside container, got wget exit ${health.code}`,
    );
    assert(
      /"status"\s*:\s*"ok"/.test(health.body),
      `/health body should be status=ok, got ${JSON.stringify(health.body)}`,
    );

    const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
    assert(stop.code === 0, `stop should exit 0, got ${stop.code}`);
  });
}

async function caseStatusNotRunning(): Promise<void> {
  await withCliDocker(async (ctx) => {
    const status = await ctx.exec(["status"], { timeoutMs: 15_000 });
    assert(
      status.code === 0,
      `status should exit 0 even when not running, got ${status.code}`,
    );
    assert(
      /not running/i.test(status.stdout),
      `pre-start status should say "not running", got ${JSON.stringify(status.stdout)}`,
    );
  });
}

async function caseStalePidFile(): Promise<void> {
  await withCliDocker(async (ctx) => {
    // Pick a PID that is almost certainly not alive in a freshly-minted
    // container. PID 1 is sleep(infinity), PID 2..~30 are plausible, so
    // use a large number well beyond that.
    const bogusPid = 999999;
    await ctx.exec(
      [
        "sh",
        "-c",
        `mkdir -p ${FLOCKCTL_HOME} && printf '%s' ${bogusPid} > ${PID_PATH}`,
      ],
      { raw: true, timeoutMs: 5_000 },
    );

    // Sanity-check the precondition: the stale file actually exists.
    const pre = await ctx.exec(
      ["sh", "-c", `test -f ${PID_PATH} && echo exists || echo missing`],
      { raw: true, timeoutMs: 5_000 },
    );
    assert(
      /exists/.test(pre.stdout),
      `stale pid file should exist before status, got ${JSON.stringify(pre.stdout)}`,
    );

    const status = await ctx.exec(["status"], { timeoutMs: 15_000 });
    assert(
      status.code === 0,
      `status should exit 0 when pid file is stale, got ${status.code}`,
    );
    assert(
      /not running/i.test(status.stdout),
      `status should report "not running" for stale pid, got ${JSON.stringify(status.stdout)}`,
    );

    const post = await ctx.exec(
      ["sh", "-c", `test -f ${PID_PATH} && echo exists || echo gone`],
      { raw: true, timeoutMs: 5_000 },
    );
    assert(
      /gone/.test(post.stdout),
      `stale pid file should be removed after status, got ${JSON.stringify(post.stdout)}`,
    );
  });
}

async function casePublicRefusal(): Promise<void> {
  await withCliDocker(async (ctx) => {
    const start = await ctx.exec(
      ["start", "--host", "0.0.0.0"],
      { timeoutMs: 30_000 },
    );
    assert(
      start.code !== 0,
      `public host without token should refuse, got exit ${start.code}; stdout=${start.stdout}`,
    );

    // The security gate prints the refusal to the child's stderr, which
    // daemon.ts redirects into flockctl.log. The parent only prints a
    // "Flockctl failed to start ... Check logs" hint. Accept either.
    const log = await readLog(ctx);
    const combined = `${start.stderr}\n${log}`;
    assert(
      /--allow-insecure-public/.test(combined),
      `refusal output should mention --allow-insecure-public; stderr=${JSON.stringify(
        start.stderr,
      )}; log head=${JSON.stringify(log.slice(0, 500))}`,
    );
    assert(
      /Refusing to bind to non-loopback/i.test(log),
      `log should contain the security-gate refusal message, got ${JSON.stringify(
        log.slice(0, 800),
      )}`,
    );
  });
}

async function casePublicBreakGlass(): Promise<void> {
  await withCliDocker(async (ctx) => {
    const start = await ctx.exec(
      ["start", "--host", "0.0.0.0", "--allow-insecure-public"],
      { timeoutMs: 30_000 },
    );
    assert(
      start.code === 0,
      `break-glass start should exit 0, got ${start.code}; stderr=${start.stderr}`,
    );

    // Now the daemon is on 0.0.0.0:52077, which the host-port mapping
    // DOES reach. Use waitForDaemon for the host-side probe as well.
    await ctx.waitForDaemon();

    const log = await readLog(ctx);
    assert(
      /\[SECURITY WARNING\]/.test(log),
      `log should include [SECURITY WARNING], got ${JSON.stringify(log.slice(0, 800))}`,
    );
    // The gate message also names the bind target — confirm it matches.
    assert(
      /WITHOUT authentication/i.test(log),
      `log should explain the "no auth" state, got ${JSON.stringify(log.slice(0, 800))}`,
    );

    const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
    assert(stop.code === 0, `stop should exit 0, got ${stop.code}`);
  });
}

async function casePublicWithToken(): Promise<void> {
  await withCliDocker(async (ctx) => {
    // Minimum token length is 32 (see config/remote-auth.ts). Use 64 hex
    // chars — matches what `flockctl token generate` emits in practice.
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const rc = JSON.stringify(
      { remoteAccessTokens: [{ label: "default", token }] },
      null,
      2,
    );
    // Pipe the rc contents via stdin to avoid shell-quoting pitfalls.
    const seed = await ctx.exec(
      ["sh", "-c", `cat > ${RC_PATH} && chmod 600 ${RC_PATH}`],
      { raw: true, stdin: rc, timeoutMs: 5_000 },
    );
    assert(
      seed.code === 0,
      `rc seeding should succeed, got exit ${seed.code}; stderr=${seed.stderr}`,
    );

    const start = await ctx.exec(
      ["start", "--host", "0.0.0.0"],
      { timeoutMs: 30_000 },
    );
    assert(
      start.code === 0,
      `token-authed public start should exit 0, got ${start.code}; stderr=${start.stderr}`,
    );

    await ctx.waitForDaemon();

    const log = await readLog(ctx);
    assert(
      /token auth active/i.test(log),
      `log should mention "token auth active", got ${JSON.stringify(log.slice(0, 800))}`,
    );
    // Make sure the [SECURITY WARNING] branch is NOT active when a token
    // is present — that would indicate the gate mis-classified the config.
    assert(
      !/\[SECURITY WARNING\]\s+Remote access enabled/.test(log),
      `token-authed start should not emit the public-without-auth warning, got ${JSON.stringify(
        log.slice(0, 800),
      )}`,
    );

    const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
    assert(stop.code === 0, `stop should exit 0, got ${stop.code}`);
  });
}

const cases: Array<[string, () => Promise<void>]> = [
  ["default start/stop/status", caseDefaultStartStop],
  ["custom port", caseCustomPort],
  ["status when not running", caseStatusNotRunning],
  ["stale pid file", caseStalePidFile],
  ["public-host refusal", casePublicRefusal],
  ["public-host break-glass", casePublicBreakGlass],
  ["public-host with token", casePublicWithToken],
];

let failed = 0;
const failures: string[] = [];
for (const [name, fn] of cases) {
  const t0 = Date.now();
  process.stdout.write(`  lifecycle: ${name} ... `);
  try {
    await fn();
    console.log(`ok (${Date.now() - t0}ms)`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`FAIL (${Date.now() - t0}ms)`);
    const e = err as Error;
    console.error(e.stack ?? e.message ?? String(err));
  }
}

if (failed > 0) {
  console.error(`\nlifecycle: ${failed} case(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}

console.log("lifecycle: ok");
