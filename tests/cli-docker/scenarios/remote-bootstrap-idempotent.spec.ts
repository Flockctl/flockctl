#!/usr/bin/env tsx
/**
 * `flockctl remote-bootstrap` idempotency (cli-docker).
 *
 * Running `remote-bootstrap` twice with the same `--label` must be a no-op
 * on the second run: the daemon is already up (the pidfile from the first
 * run points at a live process and `/health` answers), and the rc file
 * already has a `remoteAccessTokens` entry for "test-laptop", so the
 * implementation's read-decide-write path hits the early-return branch and
 * hands back the *same* token. No new mint, no rc rewrite that could
 * reorder entries.
 *
 * The assertion is intentionally stricter than "contains a 43-char token":
 *
 *   assert.strictEqual(firstStdout, secondStdout)
 *
 * Byte-equal stdout is the only thing that proves idempotency for a
 * callsite like `TOKEN=$(flockctl remote-bootstrap --print-token ...)`.
 * A non-deterministic token — even one that happened to still be valid —
 * would mean the function is actually "regenerate", not "ensure", and
 * would break any CI pipeline that re-runs bootstrap as part of a retry.
 *
 * Like the happy-path spec next door, the container is freshly built and
 * nothing is pre-seeded. Both invocations go through the real daemon-spawn
 * and rc-write paths on the first call; the second call takes the fast
 * path for both.
 *
 * Verification:
 *   npm run test:cli-docker -- --grep 'remote-bootstrap'
 */
import { strictEqual } from "node:assert/strict";
import { assert, withCliDocker, type CliDockerContext } from "../_harness.js";

const FLOCKCTL_HOME = "/flockctl-home";
const PID_PATH = `${FLOCKCTL_HOME}/flockctl.pid`;
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
  // Precondition — fresh container, nothing pre-seeded. If either side-
  // effect is already present, we're not actually exercising the
  // idempotency transition (pristine → bootstrapped → re-bootstrapped).
  assert(
    !(await pathExists(ctx, PID_PATH)),
    `precondition: pidfile ${PID_PATH} should not exist in a fresh container`,
  );
  assert(
    !(await pathExists(ctx, RC_PATH)),
    `precondition: rc file ${RC_PATH} should not exist in a fresh container`,
  );

  // ── first invocation: spawns the daemon, mints the token, writes rc ────
  const first = await ctx.exec(
    ["remote-bootstrap", "--print-token", "--label", "test-laptop"],
    { timeoutMs: 30_000 },
  );
  assert(
    first.code === 0,
    `first remote-bootstrap should exit 0, got ${first.code}; stdout=${JSON.stringify(
      first.stdout,
    )}; stderr=${JSON.stringify(first.stderr)}`,
  );
  assert(
    TOKEN_STDOUT_RE.test(first.stdout),
    `first stdout should match ${TOKEN_STDOUT_RE}; got ${JSON.stringify(
      first.stdout,
    )}`,
  );

  // Confirm the two side-effects landed — they are the fast-path inputs
  // for the second invocation.
  assert(
    await pathExists(ctx, PID_PATH),
    `${PID_PATH} should exist after first remote-bootstrap`,
  );
  assert(
    await pathExists(ctx, RC_PATH),
    `${RC_PATH} should exist after first remote-bootstrap`,
  );

  // ── second invocation: everything is already in place; both the daemon
  //                       fast-path and the rc lookup must hit ───────────
  const second = await ctx.exec(
    ["remote-bootstrap", "--print-token", "--label", "test-laptop"],
    { timeoutMs: 30_000 },
  );
  assert(
    second.code === 0,
    `second remote-bootstrap should exit 0, got ${second.code}; stdout=${JSON.stringify(
      second.stdout,
    )}; stderr=${JSON.stringify(second.stderr)}`,
  );
  assert(
    TOKEN_STDOUT_RE.test(second.stdout),
    `second stdout should match ${TOKEN_STDOUT_RE}; got ${JSON.stringify(
      second.stdout,
    )}`,
  );

  // ── the one assertion that actually proves idempotency ─────────────────
  // Non-determinism here would imply the function is "regenerate", not
  // "ensure". Byte-equal is the contract.
  strictEqual(first.stdout, second.stdout);
});

console.log("remote-bootstrap-idempotent: ok");
