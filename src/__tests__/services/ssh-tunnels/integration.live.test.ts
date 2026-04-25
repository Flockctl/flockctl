/**
 * Live integration tests for {@link SshTunnelManager} against a real
 * `ssh` binary and a real sshd on 127.0.0.1. Exercises the paths that
 * the unit suites necessarily stub (spawn, stderr classification,
 * ready-gate poll, reconnect race, SIGTERM→SIGKILL escalation) end to
 * end, so a regression in any layer surfaces here.
 *
 * ---------------------------------------------------------------------------
 * Gate
 * ---------------------------------------------------------------------------
 *
 * Guarded by `FLOCKCTL_LIVE_TESTS=1` — the same convention that
 * [AGENTS.md](../../../../AGENTS.md) uses for `npm run test:live`.
 * When the env var is unset, every test in this file is skipped with a
 * clear reason. The default `npm run test:coverage` run therefore stays
 * fast and hermetic; this file only does work when a human (or CI)
 * explicitly opts in.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites
 * ---------------------------------------------------------------------------
 *
 * 1. `sshd` running on 127.0.0.1:22. On macOS: System Settings →
 *    General → Sharing → Remote Login. On Linux: `systemctl start
 *    sshd`.
 *
 * 2. An ssh key loaded into `ssh-agent` that is authorized to connect
 *    to the current user on 127.0.0.1 (i.e. the key's public half is in
 *    `~/.ssh/authorized_keys`). Non-interactive auth is required —
 *    `BatchMode=yes` is always set, so a password prompt will fail
 *    fast with `auth_failed`.
 *
 * 3. A Flockctl daemon reachable at 127.0.0.1:52077. Scenario 1
 *    fetches `/health` through the forwarded port and expects a 200.
 *
 * 4. `StrictHostKeyChecking=accept-new` is injected by
 *    {@link buildSshArgs} so the first connection trust-on-first-uses
 *    the 127.0.0.1 key. Subsequent runs then satisfy strict checking
 *    from `~/.ssh/known_hosts`.
 *
 * When any prereq is missing the symptom is a tunnel that never
 * reaches `'ready'` — the first test will fail fast with the ssh
 * stderr attached, so the cause is visible without a debugger.
 *
 * ---------------------------------------------------------------------------
 * Scenarios
 * ---------------------------------------------------------------------------
 *
 *   1. real_ssh_to_localhost_tunnels_health
 *   2. kill_child_triggers_reconnect
 *   3. shutdown_kills_all_children
 *   4. sigterm_parent_cleans_children
 *
 * See each `describe` block for the exact flow.
 *
 * ---------------------------------------------------------------------------
 * Verification (manual, not in the default pipeline)
 * ---------------------------------------------------------------------------
 *
 *   FLOCKCTL_LIVE_TESTS=1 npx vitest run \
 *     src/__tests__/services/ssh-tunnels/integration.live.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SshTunnelManager } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";

// ---------------------------------------------------------------------------
// Gate — skip the whole file when the env var is unset.
// ---------------------------------------------------------------------------

const LIVE = process.env.FLOCKCTL_LIVE_TESTS === "1";
const SKIP_REASON =
  "Live SSH integration tests are disabled. " +
  "Set FLOCKCTL_LIVE_TESTS=1 AND ensure (a) sshd is running on 127.0.0.1, " +
  "(b) an authorized key is loaded in ssh-agent, and (c) a Flockctl daemon " +
  "is listening on 127.0.0.1:52077.";

if (!LIVE) {
  // Log a single explanatory line so CI output makes the skip visible.
   
  console.log(`[ssh-tunnels.integration.live] ${SKIP_REASON}`);
}

// Individual-test timeouts default to 10 s (see vitest.config.ts). The
// reconnect scenario needs up to ~8 s of real wall time (1 s first
// backoff slot + ssh TCP handshake + ready-gate poll), and the
// subprocess scenario awaits a 5 s deadline, so we lift the per-test
// budget to 30 s for this suite.
const TEST_TIMEOUT_MS = 30_000;

// Tests in this file are inherently racy with the real kernel / ssh
// client / daemon. A single flake shouldn't poison the signal — retry
// once so a transient TCP RST on CI localhost doesn't block the PR.
const RETRY = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the sibling fixture (scenario 4). */
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "integration.live.fixture.ts",
);

function mkServer(id: string): RemoteServerConfig {
  return { id, name: id, ssh: { host: "127.0.0.1" } };
}

/** Busy-wait for a predicate with a hard deadline. Polls every 100 ms. */
async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

/**
 * `true` iff a process with the given pid is currently alive. Uses
 * `kill(pid, 0)`, which raises ESRCH for a dead pid and EPERM for a
 * live-but-foreign pid — both interpretations matter to us only
 * insofar as we want to know "is anything still bound to this pid?"
 * so EPERM is treated as "alive".
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// describe.skipIf — the whole suite short-circuits when the gate is closed.
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE)("ssh-tunnels live integration (FLOCKCTL_LIVE_TESTS=1)", () => {
  let mgr: SshTunnelManager;

  beforeEach(() => {
    mgr = new SshTunnelManager();
  });

  afterEach(async () => {
    // Always tear everything down between tests so a failure mid-suite
    // doesn't leak ssh children into the next case.
    await mgr.shutdown().catch(() => {
      // Best-effort — even if shutdown errors we proceed; the per-test
      // assertions will have already reported the real failure.
    });
  });

  // -------------------------------------------------------------------------
  // 1. real_ssh_to_localhost_tunnels_health
  // -------------------------------------------------------------------------

  describe("real_ssh_to_localhost_tunnels_health", () => {
    it(
      "start → ready → GET /health 200 → stop",
      { timeout: TEST_TIMEOUT_MS, retry: RETRY },
      async () => {
        const handle = await mgr.start(mkServer("live-1"));

        // If this assertion fails, the error / rawStderr on the handle
        // usually tells you which prereq is missing (auth, sshd, etc.).
        expect(
          handle.status,
          `tunnel not ready: status=${handle.status} errorCode=${handle.errorCode ?? ""} stderr=${handle.rawStderr ?? ""}`,
        ).toBe("ready");
        expect(handle.localPort).toBeGreaterThan(0);

        const res = await fetch(`http://127.0.0.1:${handle.localPort}/health`);
        expect(res.status).toBe(200);

        await mgr.stop("live-1");
        expect(mgr.getByServerId("live-1")).toBeNull();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. kill_child_triggers_reconnect
  // -------------------------------------------------------------------------

  describe("kill_child_triggers_reconnect", () => {
    it(
      "SIGKILL on the ssh child brings the tunnel back to 'ready' with a new pid",
      { timeout: TEST_TIMEOUT_MS, retry: RETRY },
      async () => {
        const handle = await mgr.start(mkServer("live-2"));
        expect(handle.status).toBe("ready");

        const originalChild = mgr._canonicalChild("live-2");
        const originalPid = originalChild?.pid;
        expect(originalPid).toBeTypeOf("number");

        // Hard-kill the ssh child. This triggers the manager's
        // post-ready 'exit' listener → scheduleReconnect() → the 1 s
        // backoff slot → a fresh start() that reuses the canonical
        // entry.
        process.kill(originalPid as number, "SIGKILL");

        // Wait up to 15 s for the reconnect: 1 s backoff + ssh
        // handshake + ready-gate poll. On a loaded CI box the TCP
        // handshake can easily eat several seconds.
        await waitFor(
          () => {
            const h = mgr.getByServerId("live-2");
            const c = mgr._canonicalChild("live-2");
            return (
              h?.status === "ready" &&
              typeof c?.pid === "number" &&
              c.pid !== originalPid
            );
          },
          15_000,
          "reconnect to 'ready' with a new pid",
        );

        const after = mgr.getByServerId("live-2");
        const newChild = mgr._canonicalChild("live-2");
        expect(after?.status).toBe("ready");
        expect(newChild?.pid).toBeTypeOf("number");
        expect(newChild?.pid).not.toBe(originalPid);

        // Sanity: the new tunnel actually forwards traffic.
        const res = await fetch(`http://127.0.0.1:${after?.localPort}/health`);
        expect(res.status).toBe(200);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. shutdown_kills_all_children
  // -------------------------------------------------------------------------

  describe("shutdown_kills_all_children", () => {
    it(
      "shutdown() reaps every spawned ssh child within 4 s",
      { timeout: TEST_TIMEOUT_MS, retry: RETRY },
      async () => {
        const ids = ["live-3a", "live-3b", "live-3c"];
        for (const id of ids) {
          const h = await mgr.start(mkServer(id));
          expect(h.status).toBe("ready");
        }

        const pids = ids
          .map((id) => mgr._canonicalChild(id)?.pid)
          .filter((p): p is number => typeof p === "number");
        expect(pids).toHaveLength(3);
        for (const pid of pids) expect(pidAlive(pid)).toBe(true);

        await mgr.shutdown();

        // Poll pgrep for a matching `ssh -N -L` pattern to confirm none
        // of our pids remain. Some systems don't have pgrep — fall back
        // to per-pid `kill(0)` probing in that case.
        let pgrepAvailable = true;
        try {
          execSync("command -v pgrep", { stdio: "ignore" });
        } catch {
          pgrepAvailable = false;
        }

        const deadline = Date.now() + 4_000;
        let stillAlive: number[] = [...pids];
        while (Date.now() < deadline && stillAlive.length > 0) {
          if (pgrepAvailable) {
            let live: Set<number>;
            try {
              const out = execSync("pgrep -f 'ssh -N -L'", {
                encoding: "utf8",
              });
              live = new Set(
                out
                  .split("\n")
                  .map((s) => Number.parseInt(s.trim(), 10))
                  .filter((n) => Number.isFinite(n)),
              );
            } catch {
              // pgrep exits 1 when nothing matches.
              live = new Set();
            }
            stillAlive = pids.filter((p) => live.has(p));
          } else {
            stillAlive = pids.filter((p) => pidAlive(p));
          }
          if (stillAlive.length === 0) break;
          await new Promise<void>((r) => setTimeout(r, 100));
        }

        expect(
          stillAlive,
          `pids still alive 4 s after shutdown: ${stillAlive.join(", ")}`,
        ).toEqual([]);

        for (const id of ids) expect(mgr.getByServerId(id)).toBeNull();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 4. sigterm_parent_cleans_children
  //
  // Fork a subprocess that starts one tunnel, waits for 'ready', prints
  // its pid + the ssh grand-child pid as JSON, then sits idle. The
  // test sends SIGTERM to the subprocess and asserts:
  //   (a) the subprocess exits cleanly within 5 s;
  //   (b) the ssh grand-child pid is also gone shortly after.
  //
  // The fixture deliberately does NOT call `mgr.shutdown()` — (b) is
  // what proves parent-exit handling works beyond the explicit stop
  // paths. See {@link ./integration.live.fixture.ts}.
  // -------------------------------------------------------------------------

  describe("sigterm_parent_cleans_children", () => {
    it(
      "SIGTERM on the parent cleans up the ssh grand-child",
      { timeout: TEST_TIMEOUT_MS, retry: RETRY },
      async () => {
        const child = spawn("npx", ["tsx", FIXTURE_PATH], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => {
          stdoutBuf += c;
        });
        child.stderr?.on("data", (c: string) => {
          stderrBuf += c;
        });

        // Wait for the ready line (first newline-terminated JSON object
        // on stdout) or for the child to die early.
        let readyLine: string | null = null;
        let childExited = false;
        let childExitCode: number | null = null;
        let childExitSignal: NodeJS.Signals | null = null;
        child.once("exit", (code, signal) => {
          childExited = true;
          childExitCode = code;
          childExitSignal = signal;
        });

        await waitFor(
          () => {
            if (childExited) return true;
            const nl = stdoutBuf.indexOf("\n");
            if (nl === -1) return false;
            readyLine = stdoutBuf.slice(0, nl);
            return true;
          },
          20_000,
          "subprocess to print ready JSON",
        );

        if (childExited && !readyLine) {
          throw new Error(
            `fixture exited before ready (code=${childExitCode}, signal=${childExitSignal ?? ""}, stderr=${stderrBuf})`,
          );
        }

        const parsed = JSON.parse(readyLine as unknown as string) as {
          ready: boolean;
          parentPid: number;
          sshPid: number;
        };
        expect(parsed.ready).toBe(true);
        expect(parsed.parentPid).toBe(child.pid);
        expect(typeof parsed.sshPid).toBe("number");
        expect(pidAlive(parsed.sshPid)).toBe(true);

        // SIGTERM the parent; assert it exits cleanly within 5 s.
        child.kill("SIGTERM");
        await waitFor(() => childExited, 5_000, "subprocess exit after SIGTERM");
        expect(
          childExitCode === 0 || childExitSignal === "SIGTERM",
          `unexpected fixture exit: code=${childExitCode}, signal=${childExitSignal ?? ""}, stderr=${stderrBuf}`,
        ).toBe(true);

        // The ssh grand-child should be gone shortly after. Give it a
        // few seconds for the kernel to reap the orphaned process
        // (whether via the fixture's on-exit handler, signal
        // propagation, or ssh's own ServerAlive timeout).
        await waitFor(
          () => !pidAlive(parsed.sshPid),
          8_000,
          "ssh grand-child to die after parent SIGTERM",
        );
      },
    );
  });
});
