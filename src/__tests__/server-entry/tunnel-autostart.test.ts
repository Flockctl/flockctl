import { describe, it, expect, afterEach } from "vitest";
import {
  spawn,
  type ChildProcess,
  execFileSync,
} from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

/**
 * Integration test for the tunnel autostart + SIGTERM-during-boot contract.
 *
 * Boots the real `src/server-entry.ts` (via tsx) under an isolated HOME
 * seeded with N remote-server rc entries, and replaces the `ssh` binary on
 * PATH with a shell script that hangs 30 s but exits cleanly on SIGTERM.
 * That lets us assert two properties that only show up end-to-end:
 *
 *   1. `/health` answers within seconds even when N tunnels are mid-bootstrap.
 *      If autostart were awaited the daemon would be silent for the full
 *      ready-gate budget (10 s × N) — exactly the regression the production
 *      change (Promise.allSettled fire-and-forget) prevents.
 *
 *   2. SIGTERM'ing the daemon 500 ms into boot — i.e. while the fake ssh
 *      children are all still hanging — kills every child within the daemon's
 *      15 s graceful-stop budget. That's the proof that `manager.shutdown()`
 *      is on the shutdown path and runs alongside the existing DB/Hono/chat
 *      drains rather than after them.
 *
 * We never depend on a real ssh binary — PATH is explicitly prefixed to the
 * fake's directory before spawn, and the fake's path is used as the pgrep
 * needle so we don't collide with unrelated `ssh -N` processes on the test
 * machine.
 */

const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..");

async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close();
        rej(new Error("could not get free port"));
      }
    });
  });
}

/**
 * Drop a shell script named `ssh` into `<home>/bin/` and return that bin
 * dir. The script:
 *   - traps SIGTERM/SIGINT and exits 0 promptly (so `manager.shutdown()`
 *     sees a clean reap inside the 3 s SIGTERM grace window, not a SIGKILL
 *     escalation);
 *   - backgrounds `sleep 30 &` and waits on it so the trap can actually
 *     fire — `exec sleep 30` would replace the shell and mask the argv the
 *     test greps for;
 *   - keeps the original argv (`-N -o … -L …`) on its own cmdline so
 *     `pgrep -f` against the fake's path matches exactly the processes the
 *     daemon spawned.
 */
function installFakeSsh(home: string): string {
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const sshPath = join(binDir, "ssh");
  const script = [
    "#!/bin/sh",
    // Record invocations — not strictly needed for the assertions, but
    // makes triage of a failing test trivial (`cat $HOME/ssh.log`).
    `echo "invoked: $@" >> "${home}/ssh.log"`,
    "trap 'kill $pid 2>/dev/null; exit 0' TERM INT",
    "sleep 30 &",
    "pid=$!",
    "wait $pid",
    "",
  ].join("\n");
  writeFileSync(sshPath, script);
  chmodSync(sshPath, 0o755);
  return binDir;
}

interface Booted {
  child: ChildProcess;
  home: string;
  binDir: string;
  port: number;
  stderrBuf: { value: string };
  stdoutBuf: { value: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const active: Booted[] = [];

async function bootDaemon(params: {
  remoteServers: unknown[];
}): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "flockctl-tunnel-autostart-"));
  const binDir = installFakeSsh(home);
  writeFileSync(
    join(home, ".flockctlrc"),
    JSON.stringify({ remoteServers: params.remoteServers }),
    { mode: 0o600 },
  );

  const port = await pickFreePort();
  // Spawn `tsx` directly (not via `npx`) so SIGTERM is delivered to the Node
  // process that runs server-entry.ts — npx wraps the child and on some
  // platforms swallows or races signal forwarding, which surfaces as
  // `code === null` (signal-killed) instead of the clean `process.exit(0)`
  // we expect from the SIGTERM handler.
  const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
  const child = spawn(
    tsxBin,
    [join(repoRoot, "src/server-entry.ts"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Prefix PATH so `child_process.spawn("ssh", …)` inside the daemon
        // resolves to our fake before any real ssh on the system path.
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: home,
        FLOCKCTL_HOME: home,
        FLOCKCTL_MOCK_AI: "1",
      },
      cwd: repoRoot,
    },
  );

  const stderrBuf = { value: "" };
  const stdoutBuf = { value: "" };
  child.stderr?.on("data", (d) => {
    stderrBuf.value += d.toString();
  });
  child.stdout?.on("data", (d) => {
    stdoutBuf.value += d.toString();
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((res) => {
    child.once("exit", (code, signal) => res({ code, signal }));
  });

  const booted: Booted = {
    child,
    home,
    binDir,
    port,
    stderrBuf,
    stdoutBuf,
    exited,
  };
  active.push(booted);
  return booted;
}

async function waitForHealth(
  port: number,
  child: ChildProcess,
  logs: () => string,
  timeoutMs: number,
): Promise<number> {
  const start = Date.now();
  const baseUrl = `http://127.0.0.1:${port}`;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return Date.now() - start;
    } catch {
      /* not ready */
    }
    if (child.exitCode !== null) {
      throw new Error(
        `daemon exited early (${child.exitCode}) before /health answered\n` +
          `--- logs ---\n${logs()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `/health did not answer within ${timeoutMs}ms\n--- logs ---\n${logs()}`,
  );
}

/**
 * Count processes whose full argv contains the fake-ssh absolute path. Using
 * the absolute path as the needle scopes the match to this test's children
 * and won't collide with the CI runner's ambient ssh processes.
 *
 * Returns 0 if pgrep finds nothing (pgrep exits 1 in that case; we swallow
 * it). Any other non-zero exit is surfaced as a thrown error.
 */
function countFakeSshProcesses(binDir: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", join(binDir, "ssh")], {
      encoding: "utf-8",
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0).length;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return 0; // pgrep's "no matches" exit code
    throw err;
  }
}

afterEach(async () => {
  while (active.length > 0) {
    const b = active.pop()!;
    if (b.child.exitCode === null) {
      b.child.kill("SIGTERM");
      // Best-effort — give the shutdown path a window, then SIGKILL if stuck.
      await Promise.race([
        b.exited,
        new Promise((r) => setTimeout(r, 16_000)),
      ]);
      if (b.child.exitCode === null) b.child.kill("SIGKILL");
    }
    // Last-resort sweep: any fake-ssh children that outlived cleanup would
    // poison the next test's pgrep assertion.
    try {
      execFileSync("pkill", ["-9", "-f", join(b.binDir, "ssh")]);
    } catch {
      /* pkill exits 1 when nothing matched */
    }
    try {
      rmSync(b.home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("server-entry tunnel autostart", () => {
  it(
    "does not block /health behind N ssh handshakes",
    async () => {
      const booted = await bootDaemon({
        remoteServers: [
          { id: "s1", name: "srv1", ssh: { host: "user@h1.example" } },
          { id: "s2", name: "srv2", ssh: { host: "user@h2.example" } },
          { id: "s3", name: "srv3", ssh: { host: "user@h3.example" } },
        ],
      });

      // /health must answer well before the per-tunnel ready-gate cap (10 s).
      // Give it 8 s to clear boot + migrations on cold hardware; anything
      // serialized on 3 ssh handshakes would miss that budget.
      const ms = await waitForHealth(
        booted.port,
        booted.child,
        () => booted.stderrBuf.value + booted.stdoutBuf.value,
        8_000,
      );
      expect(ms).toBeLessThan(8_000);

      // Fake ssh children should have been spawned — proves autostart ran,
      // not merely that the bad path was skipped. Each rc entry → one ssh.
      const running = countFakeSshProcesses(booted.binDir);
      expect(running).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  it(
    "SIGTERM during boot autostart kills every ssh child within the 15s budget",
    async () => {
      const booted = await bootDaemon({
        remoteServers: [
          { id: "s1", name: "srv1", ssh: { host: "user@h1.example" } },
          { id: "s2", name: "srv2", ssh: { host: "user@h2.example" } },
          { id: "s3", name: "srv3", ssh: { host: "user@h3.example" } },
        ],
      });

      // Wait until at least one ssh child is up so we're really SIGTERMing
      // *during* the fan-out, not before it started. Cap at 5 s so a flaky
      // cold-start doesn't hide a real regression.
      const spawnDeadline = Date.now() + 5_000;
      while (Date.now() < spawnDeadline) {
        if (countFakeSshProcesses(booted.binDir) > 0) break;
        if (booted.child.exitCode !== null) {
          throw new Error(
            `daemon exited before any ssh child spawned\n---\n${booted.stderrBuf.value}${booted.stdoutBuf.value}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(countFakeSshProcesses(booted.binDir)).toBeGreaterThan(0);

      // Deliver SIGTERM mid-fanout and time the full drain.
      const shutdownStart = Date.now();
      booted.child.kill("SIGTERM");
      const result = await Promise.race([
        booted.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (_, rej) =>
            setTimeout(
              () => rej(new Error("daemon did not exit within 15s")),
              15_000,
            ),
        ),
      ]);
      const shutdownTookMs = Date.now() - shutdownStart;
      // Accept either a clean `process.exit(0)` from the SIGTERM handler
      // (the ideal path) *or* a SIGTERM-signal exit. On Linux CI the Node
      // runtime occasionally reports the exit as signal-killed even when
      // the shutdown handler ran to completion (`remaining === 0` below
      // is the load-bearing proof — if the handler hadn't run, the fake
      // ssh children would still be alive). Anything else (non-zero
      // code, SIGKILL, or some other signal) is a real regression.
      const cleanExit = result.code === 0 || result.signal === "SIGTERM";
      expect(
        cleanExit,
        `daemon shutdown was not clean: code=${result.code} signal=${result.signal}`,
      ).toBe(true);
      expect(shutdownTookMs).toBeLessThan(15_000);

      // The whole point: after the daemon exits, no orphaned ssh children
      // remain. If `manager.shutdown()` hadn't been on the SIGTERM path,
      // these would live for the full 30 s fake-sleep.
      const remaining = countFakeSshProcesses(booted.binDir);
      expect(remaining).toBe(0);
    },
    45_000,
  );
});
