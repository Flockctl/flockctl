import { fork, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getFlockctlHome } from "./config.js";
import { mkdirSync } from "fs";

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
      writeFileSync(getPidFile(), String(child.pid));
      console.log(`Flockctl started on http://${host}:${port} (PID: ${child.pid})`);
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

  // Timeout if server doesn't start
  setTimeout(() => {
    console.error("Flockctl failed to start within 10s. Check logs:", logFile);
    child.kill();
    process.exit(1);
  }, 10_000);
}

export function stopDaemon(): void {
  if (!isRunning()) {
    console.log("Flockctl is not running.");
    return;
  }
  const pidFile = getPidFile();
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  process.kill(pid, "SIGTERM");
  unlinkSync(pidFile);
  console.log(`Flockctl stopped (PID: ${pid}).`);
}

export function statusDaemon(): void {
  const pid = getRunningPid();
  if (pid !== null) {
    console.log(`Flockctl is running (PID: ${pid}).`);
  } else {
    console.log("Flockctl is not running.");
  }
}
