#!/usr/bin/env tsx
/**
 * `flockctl remote-bootstrap` happy-path (cli-docker).
 *
 * The container is freshly built from the `flockctl-cli-test:local` image
 * with the CLI globally installed. Nothing is pre-seeded: no daemon is
 * running, no pidfile exists, and `/root/.flockctlrc` is absent. The
 * single-shot `remote-bootstrap` command has to do three things in order
 * and have them all succeed:
 *
 *   1. Spawn the daemon and wait until `/health` answers 200 on port 52077.
 *   2. Mint a base64url token for the requested label and persist it to
 *      `~/.flockctlrc`.
 *   3. Print `token + "\n"` to stdout — and ONLY that, because callers like
 *      `TOKEN=$(flockctl remote-bootstrap --print-token ...)` depend on the
 *      byte-exact output contract.
 *
 * Assertions pin that contract:
 *   - exit code 0
 *   - stdout matches /^[A-Za-z0-9_-]{20,}\n$/ (no banners, no color codes,
 *     no progress spinners) — the production regex for the token alphabet
 *     is 43 chars of base64url; we accept ≥20 here so this test stays valid
 *     if the token length is ever lengthened.
 *   - `flockctl status` reports the daemon as running.
 *   - both of the "after" side-effects are real: `/flockctl-home/flockctl.pid`
 *     exists AND `/root/.flockctlrc` exists (so the idempotent-reuse spec
 *     next door has a meaningful precondition).
 *
 * Verification:
 *   npm run test:cli-docker -- --grep 'remote-bootstrap'
 */
import { assert, withCliDocker, type CliDockerContext } from "../_harness.js";

const FLOCKCTL_HOME = "/flockctl-home";
const PID_PATH = `${FLOCKCTL_HOME}/flockctl.pid`;
// Container runs as root (no USER in tests/cli-docker/Dockerfile), so HOME=/root.
const RC_PATH = "/root/.flockctlrc";

/** base64url + "\n" — exactly what remote-bootstrap.ts promises on stdout. */
const TOKEN_STDOUT_RE = /^[A-Za-z0-9_-]{20,}\n$/;

async function pathExists(ctx: CliDockerContext, p: string): Promise<boolean> {
  const r = await ctx.exec(
    ["sh", "-c", `test -f ${p} && echo yes || echo no`],
    { raw: true, timeoutMs: 5_000 },
  );
  return /yes/.test(r.stdout);
}

await withCliDocker(async (ctx) => {
  // Precondition: truly a pristine container — no pidfile, no rc. If either
  // exists, the harness isn't giving us what the spec needs and the test's
  // observations are meaningless.
  assert(
    !(await pathExists(ctx, PID_PATH)),
    `precondition: pidfile ${PID_PATH} should not exist in a fresh container`,
  );
  assert(
    !(await pathExists(ctx, RC_PATH)),
    `precondition: rc file ${RC_PATH} should not exist in a fresh container`,
  );

  // ── step 1: run remote-bootstrap and capture stdout byte-exact ──────────
  const r = await ctx.exec(
    ["remote-bootstrap", "--print-token", "--label", "test-laptop"],
    { timeoutMs: 30_000 },
  );
  assert(
    r.code === 0,
    `remote-bootstrap should exit 0, got ${r.code}; stdout=${JSON.stringify(
      r.stdout,
    )}; stderr=${JSON.stringify(r.stderr)}`,
  );

  // Byte-exact stdout — no banners, no color codes, no progress output.
  // A single line: token + "\n".
  assert(
    TOKEN_STDOUT_RE.test(r.stdout),
    `stdout should match ${TOKEN_STDOUT_RE}; got ${JSON.stringify(r.stdout)}`,
  );

  // ── step 2: confirm the daemon is actually running (not just that the
  //           token got printed) ───────────────────────────────────────────
  const status = await ctx.exec(["status"], { timeoutMs: 15_000 });
  assert(
    status.code === 0,
    `status should exit 0, got ${status.code}; stderr=${status.stderr}`,
  );
  // `status` writes "running" (no "not running") when the daemon is up.
  assert(
    /running/i.test(status.stdout) && !/not running/i.test(status.stdout),
    `status should report running after remote-bootstrap, got ${JSON.stringify(
      status.stdout,
    )}`,
  );

  // ── step 3: side-effects visible on disk ───────────────────────────────
  // These are what let the next spec (idempotency) assert "reuse": the rc
  // file and the pidfile both exist before the second bootstrap runs.
  assert(
    await pathExists(ctx, PID_PATH),
    `${PID_PATH} should exist after remote-bootstrap`,
  );
  assert(
    await pathExists(ctx, RC_PATH),
    `${RC_PATH} should exist after remote-bootstrap`,
  );
});

console.log("remote-bootstrap: ok");
