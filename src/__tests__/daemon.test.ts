import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the daemon functions by setting FLOCKCTL_HOME to a temp dir
describe("daemon", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flockctl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.FLOCKCTL_HOME = tempDir;
  });

  afterEach(() => {
    delete process.env.FLOCKCTL_HOME;
    // Clean up temp dir
    try {
      const pidFile = join(tempDir, "flockctl.pid");
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch { /* ignore */ }
  });

  it("isRunning returns false when no PID file exists", async () => {
    const { isRunning } = await import("../daemon.js");
    expect(isRunning()).toBe(false);
  });

  it("isRunning returns false with stale PID file", async () => {
    const pidFile = join(tempDir, "flockctl.pid");
    // Write a PID that doesn't exist (99999999 is unlikely to be a real process)
    writeFileSync(pidFile, "99999999");
    const { isRunning } = await import("../daemon.js");
    expect(isRunning()).toBe(false);
    // Stale PID file should be cleaned up
    expect(existsSync(pidFile)).toBe(false);
  });

  it("isRunning returns true for current process PID", async () => {
    const pidFile = join(tempDir, "flockctl.pid");
    writeFileSync(pidFile, String(process.pid));
    const { isRunning } = await import("../daemon.js");
    expect(isRunning()).toBe(true);
  });

  it("getRunningPid returns null when not running", async () => {
    const { getRunningPid } = await import("../daemon.js");
    expect(getRunningPid()).toBeNull();
  });

  it("getRunningPid returns PID for running process", async () => {
    const pidFile = join(tempDir, "flockctl.pid");
    writeFileSync(pidFile, String(process.pid));
    const { getRunningPid } = await import("../daemon.js");
    expect(getRunningPid()).toBe(process.pid);
  });
});
