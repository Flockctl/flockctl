import { fork, type ChildProcess } from "child_process";
import {
  readFileSync,
  unlinkSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "node:timers/promises";
import { getFlockctlHome } from "./config/index.js";
import { mkdirSync } from "fs";

// Graceful-stop budget: must be >= the `chatExecutor.waitForIdle(...)` timeout
// in server-entry.ts so the CLI doesn't return before the daemon has had a
// chance to flush per-chat `claudeSessionId` updates. Aligning both numbers
// keeps chat-resume working across `make reinstall` / `flockctl stop && start`.
const GRACEFUL_STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 100;

// Startup timeout — how long to wait for the forked server-entry to send
// `ready` before giving up. Overridable via env for slow hardware / CI.
function getStartupTimeoutMs(): number {
  const raw = process.env.FLOCKCTL_STARTUP_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

function getDataDir(): string {
  const dir = getFlockctlHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getPidFile(): string {
  return join(getDataDir(), "flockctl.pid");
}

function getLogFile(): string {
  return join(getDataDir(), "flockctl.log");
}

export function isRunning(): boolean {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    unlinkSync(pidFile); // Stale PID file
    return false;
  }
}

export function getRunningPid(): number | null {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) return null;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    unlinkSync(pidFile);
    return null;
  }
}

/**
 * Atomically claim the pidfile for a newly-spawned daemon. Uses O_EXCL so two
 * concurrent `flockctl start` / `remote-bootstrap` invocations can't both
 * believe they won the race — the loser sees `EEXIST` and bails out. Returns
 * `true` if we wrote the pid, `false` if someone else already had the file.
 *
 * A stale pidfile (points at a dead process) is treated as up-for-grabs: we
 * clear it and retry the exclusive open once. Any other error bubbles up.
 */
export function claimPidFile(pid: number): boolean {
  const pidFile = getPidFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY — fails with EEXIST if the file
      // already exists, which is exactly the concurrency fence we want.
      fd = openSync(pidFile, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Someone else claimed it. If that claim is stale (process is gone),
      // `getRunningPid` will unlink and return null — giving us a second
      // chance to win the race on the retry.
      if (getRunningPid() === null && attempt === 0) continue;
      return false;
    }
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    return true;
  }
  return false;
}

export interface DaemonStartOptions {
  port: number;
  host?: string;
  allowInsecurePublic?: boolean;
}

export function startDaemon(opts: DaemonStartOptions): void {
  const { port, host = "127.0.0.1", allowInsecurePublic = false } = opts;

  if (isRunning()) {
    console.log("Flockctl is already running.");
    process.exit(1);
  }

  const logFile = getLogFile();
  const out = openSync(logFile, "a");

  // Resolve the server-entry.js path relative to this file
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(__dirname, "server-entry.js");

  const childArgs = ["--port", String(port), "--host", host];
  if (allowInsecurePublic) childArgs.push("--allow-insecure-public");

  const child: ChildProcess = fork(entryPath, childArgs, {
    detached: true,
    stdio: ["ignore", out, out, "ipc"],
  });

  child.on("message", (msg) => {
    if (msg === "ready") {
      // Use an O_EXCL-backed claim so a second `flockctl start` (or a
      // racing `remote-bootstrap`) can't silently overwrite our pidfile.
      // If we lose the race we log the winning pid and exit cleanly — the
      // caller still gets "daemon is up" semantics because /health now
      // answers, just from somebody else's server.
      const won = claimPidFile(child.pid!);
      if (won) {
        console.log(
          `Flockctl started on http://${host}:${port} (PID: ${child.pid})`,
        );
      } else {
        const existingPid = getRunningPid();
        console.log(
          `Flockctl already running (PID: ${existingPid ?? "unknown"}). ` +
            `The server we just forked will exit.`,
        );
        child.kill();
      }
      child.disconnect();
      child.unref();
      process.exit(0);
    }
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(
        `Flockctl failed to start (exit code ${code}). Check logs: ${logFile}`,
      );
      process.exit(code);
    }
  });

  child.on("error", (err) => {
    console.error("Failed to start Flockctl:", err.message);
    process.exit(1);
  });

  // Timeout if server doesn't start. Overridable via FLOCKCTL_STARTUP_TIMEOUT_MS.
  const startupTimeoutMs = getStartupTimeoutMs();
  setTimeout(() => {
    console.error(
      `Flockctl failed to start within ${Math.round(
        startupTimeoutMs / 1000,
      )}s. Check logs: ${logFile}`,
    );
    child.kill();
    process.exit(1);
  }, startupTimeoutMs);
}

export async function stopDaemon(): Promise<void> {
  if (!isRunning()) {
    console.log("Flockctl is not running.");
    return;
  }
  const pidFile = getPidFile();
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  process.kill(pid, "SIGTERM");

  // Poll until the target process is actually gone. The server-entry shutdown
  // handler drains in-flight chat streams (so `claudeSessionId` writes finish)
  // before calling `process.exit(0)` — returning from `flockctl stop` earlier
  // would race that flush, which is exactly the bug that made `make reinstall`
  // clobber chat context.
  const deadline = Date.now() + GRACEFUL_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      // Process is gone — clean up PID file if the child didn't (exit via
      // process.exit doesn't remove it) and we're done.
      if (existsSync(pidFile)) unlinkSync(pidFile);
      console.log(`Flockctl stopped (PID: ${pid}).`);
      return;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  // Timed out — warn loudly but do NOT SIGKILL. A forced kill here is exactly
  // what corrupts chat-resume state; leave the decision to the operator.
  console.warn(
    `Flockctl (PID ${pid}) did not exit within ${Math.round(
      GRACEFUL_STOP_TIMEOUT_MS / 1000,
    )}s. It may still be draining an in-flight chat. Rerun \`flockctl stop\` to wait ` +
      `again, or send SIGKILL manually if you're sure it's hung.`,
  );
}

export function statusDaemon(): void {
  const pid = getRunningPid();
  if (pid !== null) {
    console.log(`Flockctl is running (PID: ${pid}).`);
  } else {
    console.log("Flockctl is not running.");
  }
}
