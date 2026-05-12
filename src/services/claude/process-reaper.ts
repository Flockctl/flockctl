/**
 * Watchdog for `claude` SDK subprocesses spawned via
 * `@anthropic-ai/claude-agent-sdk`. Closes two leaks the SDK does not handle:
 *
 *   1. **Hung-after-abort** — `controller.abort()` is the SDK's only exit
 *      lever. When the SDK ignores it (MCP stuck, stdio deadlock,
 *      stream-parser race), the spawned `claude` binary keeps running, the
 *      `for await` in `streamViaClaudeAgentSDK` never returns, and the chat
 *      stays `isRunning=true` forever. The UI shows "Thinking…" with no way
 *      to recover short of a daemon restart.
 *
 *   2. **Clean-exit orphans** — the SDK occasionally exits its async iterator
 *      without killing the `claude` child. Flockctl never had a PID handle
 *      (the SDK doesn't expose it), so once `unregister()` ran the JS side
 *      forgot the subprocess and it lingered as a true zombie holding open
 *      file descriptors and unix-socket peers to dead pipes (verified via
 *      lsof — these orphans had zero TCP sockets, only stdin/stdout to a
 *      Node end nobody was reading).
 *
 * The fix is intentionally external to the SDK: discover PIDs via `ps`
 * (children of this process whose argv matches the SDK's bundled `claude`
 * binary), maintain a small in-memory registry, and run a periodic poller
 * that SIGTERM→grace→SIGKILL any PID whose owning session has marked itself
 * "should be dead by now" via {@link markAbort}.
 *
 * macOS/Linux only. Flockctl does not support Windows (CLAUDE.md rule 6).
 */

import { execFileSync } from "node:child_process";

/** A live `claude` SDK subprocess that's a child of the current process. */
export interface ClaudeChild {
  pid: number;
  /** Wall-clock seconds since the subprocess started (from `ps -o etime`). */
  etimeSec: number;
  /** The resume session id from `--resume <uuid>`, or null when not resuming. */
  resumeId: string | null;
}

// `ps` argv hits the SDK-bundled binary at
// node_modules/@anthropic-ai/claude-agent-sdk-<arch>/claude
const CLAUDE_CMD_PATTERN = /node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\/claude\b/;
const RESUME_FLAG_PATTERN = /--resume\s+([0-9a-f-]{20,})/i;

// PID registry. Key = pid we've spawned via the SDK. Value carries the
// abort-stamp used by the poller to decide when to force-kill.
interface TrackedPid {
  /** Wall-clock ms when abort was signalled. null = still expected to be running. */
  abortAt: number | null;
}
const trackedPids: Map<number, TrackedPid> = new Map();

let reaperHandle: ReturnType<typeof setInterval> | null = null;
let reaperGraceMs = 5_000;

/** Register a PID we've just identified as our SDK subprocess. Idempotent. */
export function trackPid(pid: number): void {
  if (!trackedPids.has(pid)) trackedPids.set(pid, { abortAt: null });
}

/** Mark a tracked PID as "should be dead by now" — the poller will kill it
 *  after the configured grace window. No-op for unknown PIDs (they are not
 *  ours to kill). */
export function markAbort(pid: number): void {
  const entry = trackedPids.get(pid);
  if (!entry) return;
  if (entry.abortAt === null) entry.abortAt = Date.now();
}

/** Drop a PID from tracking — call when the subprocess is confirmed gone. */
export function untrack(pid: number): void {
  trackedPids.delete(pid);
}

/** Test-only: snapshot the current tracking map. */
export function _trackedPidsSnapshot(): Map<number, TrackedPid> {
  return new Map(trackedPids);
}

/** Test-only: clear all tracking state. */
export function _resetTrackingForTests(): void {
  trackedPids.clear();
}

/**
 * Parse a `ps -A -o pid=,ppid=,etime=,command=` output blob into the
 * `ClaudeChild[]` shape. Pulled out of the sync/async variants below so the
 * two paths share one parser.
 */
function parsePsOutput(raw: string, parentPid: number): ClaudeChild[] {
  const out: ClaudeChild[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // pid ppid etime command
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (ppid !== parentPid) continue;
    const cmd = m[4]!;
    if (!CLAUDE_CMD_PATTERN.test(cmd)) continue;
    const resumeMatch = RESUME_FLAG_PATTERN.exec(cmd);
    out.push({
      pid,
      etimeSec: parseEtime(m[3]!),
      resumeId: resumeMatch ? resumeMatch[1]! : null,
    });
  }
  return out;
}

/**
 * List `claude` SDK subprocesses whose parent is the given pid (default: this
 * process). One `ps` invocation. Returns an empty array if `ps` is missing
 * (non-POSIX — Flockctl doesn't run on Windows per CLAUDE.md rule 6) or
 * times out.
 *
 * NOTE: this is the SYNC variant — it blocks the event loop for the
 * duration of the `ps` spawn (a few ms on a quiet box, up to tens of ms on
 * a host with thousands of processes). Prefer `listClaudeChildrenAsync` in
 * any async-context call site to avoid stalling concurrent HTTP / WS work.
 */
export function listClaudeChildren(parentPid: number = process.pid): ClaudeChild[] {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,command="], {
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    }).toString();
  } catch {
    /* v8 ignore next 2 — `ps` failure path; on macOS/Linux the binary is
       always present and the timeout is generous, so this branch only fires
       in degenerate test environments */
    return [];
  }
  return parsePsOutput(raw, parentPid);
}

/**
 * Async sibling of `listClaudeChildren`. Same return shape, but doesn't
 * block the Node event loop while `ps` runs — concurrent HTTP / WS work
 * stays responsive on a host with many processes. Prefer this from
 * `async` call sites (cli.ts:runClaude, ai/client.ts).
 */
export async function listClaudeChildrenAsync(
  parentPid: number = process.pid,
): Promise<ClaudeChild[]> {
  // Dynamic-imports keep the partial-mock-friendly contract that the
  // sync variant uses (the unit test mocks `node:child_process` and only
  // defines `execFileSync`; resolving `execFile` at module-load would
  // fail there). `promisify(execFile)` is rebuilt per call — cheap and
  // safe; the underlying spawn is what dominates cost.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-A", "-o", "pid=,ppid=,etime=,command="],
      { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    /* v8 ignore next — same defensive net as the sync variant */
    return [];
  }
  return parsePsOutput(raw, parentPid);
}

/**
 * Parse `ps -o etime` output. Format is `[[DD-]HH:]MM:SS`.
 *
 *   `42`        → 42 seconds (some implementations omit minutes)
 *   `01:23`     → 1 minute 23 seconds
 *   `01:02:03`  → 1 hour 2 minutes 3 seconds
 *   `2-03:04:05`→ 2 days 3 hours 4 minutes 5 seconds
 */
export function parseEtime(s: string): number {
  let rest = s;
  let days = 0;
  const dashIdx = rest.indexOf("-");
  if (dashIdx >= 0) {
    days = Number(rest.slice(0, dashIdx)) || 0;
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((p) => Number(p) || 0);
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts as [number, number, number];
  else if (parts.length === 2) [m, sec] = parts as [number, number];
  /* v8 ignore next — single-component etime is uncommon (mostly under-1-min procs),
     covered by parseEtime unit tests but rarely hit in practice */
  else if (parts.length === 1) sec = parts[0]!;
  return days * 86_400 + h * 3_600 + m * 60 + sec;
}

/** Probe — `kill -0` returns true iff PID is alive AND we own it. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM, wait up to `gracefulMs`, then SIGKILL if still alive. Resolves to
 * `true` when the PID is gone after the call (or never existed). Idempotent.
 */
export async function killClaudePid(pid: number, gracefulMs = 5_000): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }

  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!pidAlive(pid)) return true;

  /* v8 ignore start — SIGKILL fallback only fires when SIGTERM is ignored
     past the grace window; covered by integration paths, not unit-tested
     here because mocking process.kill timing is brittle */
  try { process.kill(pid, "SIGKILL"); } catch { return !pidAlive(pid); }
  await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
  /* v8 ignore stop */
}

/**
 * One reaper sweep: walk tracked PIDs, kill any whose abort was signalled
 * more than `graceMs` ago. Exposed for direct invocation from tests.
 */
export async function reapNow(graceMs = reaperGraceMs): Promise<number[]> {
  const now = Date.now();
  const killed: number[] = [];
  for (const [pid, entry] of trackedPids) {
    // Untrack any tracked PIDs that died on their own (clean SDK exit).
    if (!pidAlive(pid)) {
      untrack(pid);
      continue;
    }
    if (entry.abortAt === null) continue;
    if (now - entry.abortAt < graceMs) continue;
    const ok = await killClaudePid(pid, 1_000);
    if (ok) {
      untrack(pid);
      killed.push(pid);
    }
    /* v8 ignore next 2 — killClaudePid only returns false if SIGKILL itself
       fails, which is unreachable for a PID we own on macOS/Linux */
  }
  return killed;
}

/**
 * Start the periodic poller. Idempotent — a second start with different
 * settings replaces the first interval. Returns a stop function.
 */
export function startReaper(opts?: { intervalMs?: number; graceMs?: number }): () => void {
  const intervalMs = opts?.intervalMs ?? 10_000;
  reaperGraceMs = opts?.graceMs ?? 5_000;

  if (reaperHandle !== null) clearInterval(reaperHandle);
  reaperHandle = setInterval(() => {
    void reapNow(reaperGraceMs);
  }, intervalMs);
  // unref so the timer never blocks process exit (graceful shutdown stays in
  // chat-executor's hands).
  reaperHandle.unref?.();

  return stopReaper;
}

/** Stop the periodic poller. Idempotent. */
export function stopReaper(): void {
  if (reaperHandle !== null) {
    clearInterval(reaperHandle);
    reaperHandle = null;
  }
}
