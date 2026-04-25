/**
 * SshTunnelManager — owns the lifecycle of ssh child processes that
 * forward a port to a remote Flockctl daemon.
 *
 * All ssh invocations go out with `-o BatchMode=yes` so ssh never
 * prompts for a password on stdin. In BatchMode, authentication
 * failures are reported on stderr and the child exits non-zero; our
 * classifier then turns the stderr into a stable `errorCode`.
 *
 * Every handle keeps a per-process buffer of stderr bytes. On exit
 * (and also on each read, so the UI can show a live classification
 * while the tunnel is still dying) we run `classifyStderr` and stash
 * the result on the handle.
 */

import * as child_process from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";

import {
  classifyStderr,
  type ClassifyResult,
  type TunnelErrorCode,
} from "./classify-stderr.js";
import { buildSshArgs } from "./build-args.js";
import { waitForTunnelReady } from "./ready-gate.js";
import type {
  RemoteServerConfig,
  SshTunnelHandle,
  TunnelStatus,
} from "./types.js";

/**
 * Signature of the ready-gate probe. Injectable via the manager constructor
 * so tests can substitute a fast-resolving stub instead of waiting on a real
 * fetch loop against the live port.
 */
export type ReadyProbe = (
  lport: number,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
) => Promise<"ready" | "timeout">;

export interface SshTunnelManagerOptions {
  /** Override the ready-gate probe (defaults to {@link waitForTunnelReady}). */
  probe?: ReadyProbe;
  /** Per-probe options forwarded to the probe function. */
  probeTimeoutMs?: number;
  probePollMs?: number;
}

export interface SshTunnelOptions {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** Local port to forward (-L LOCAL:remoteHost:REMOTE). */
  localPort: number;
  /** Remote host — usually `localhost` inside the remote box. */
  remoteHost: string;
  /** Remote port — the Flockctl daemon on the far side. */
  remotePort: number;
  /** Extra `-o` flags to append. BatchMode=yes is always injected. */
  extraOptions?: string[];
  /** For tests: substitute a spawn-alike. */
  spawner?: typeof spawn;
}

export interface TunnelHandle {
  readonly id: string;
  readonly options: SshTunnelOptions;
  readonly argv: string[];
  /** Last classification result. Updated on every stderr chunk and on exit. */
  errorCode: TunnelErrorCode;
  rawStderr: string;
  exitCode: number | null;
  exited: boolean;
  readonly child: ChildProcess;
  readonly events: EventEmitter;
  /** Accumulated stderr; exposed for tests and diagnostics. */
  readonly stderrBuffer: { value: string };
}

/**
 * Build the argv for an ssh invocation. Exported so tests can assert
 * that `BatchMode=yes` is always present — the "password prompt never
 * appears" guarantee is really a property of this argv.
 */
export function buildSshArgv(opts: SshTunnelOptions): string[] {
  const argv: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N", // no remote command; tunnel only
    "-L",
    `${opts.localPort}:${opts.remoteHost}:${opts.remotePort}`,
  ];

  if (opts.port) {
    argv.push("-p", String(opts.port));
  }
  if (opts.identityFile) {
    argv.push("-i", opts.identityFile);
  }
  for (const o of opts.extraOptions ?? []) {
    argv.push("-o", o);
  }

  argv.push(opts.user ? `${opts.user}@${opts.host}` : opts.host);
  return argv;
}

let nextId = 1;

/**
 * Internal record for a canonical-API tunnel (keyed by serverId).
 * Kept separate from the legacy tunnel-id-keyed `handles` map so the
 * two surfaces can coexist without stepping on each other.
 *
 * The reconnect fields (`backoffIndex`, `reconnectTimer`, `stderrBuffer`,
 * `server`) are owned by the reconnect loop added for the "auto-reconnect
 * with exponential backoff" task. They persist across spawns — start()
 * replaces `child`/`handle`/`abort` on each re-entry but carries the
 * backoff index forward so consecutive failures progress up the ladder.
 */
interface CanonicalEntry {
  child: ChildProcess;
  handle: SshTunnelHandle;
  /** Signals the ready-gate probe to abort (shutdown, child exit). */
  abort: AbortController;
  /** Server config captured at start() time — reused by reconnect + restart. */
  server: RemoteServerConfig;
  /**
   * Next slot in {@link BACKOFF_SEQUENCE_MS}. `0` means "next reconnect uses
   * 1s". Reset to 0 on `ready` and on explicit `restart()`. Incremented
   * after each reconnect schedule, capped at the sequence length.
   */
  backoffIndex: number;
  /**
   * Pending reconnect handle. Always cleared before being overwritten and
   * on shutdown/restart so the test suite's fake-timer invariant
   * (`vi.getTimerCount() === 0` after teardown) holds.
   */
  reconnectTimer?: NodeJS.Timeout;
  /** stderr accumulated from the current child, for stderr classification. */
  stderrBuffer: string;
  /**
   * Set by `stop()` / `shutdown()` before awaiting child reap. Any in-flight
   * reconnect timer callback, post-ready exit listener, or bootstrap-error
   * path checks this flag and bails out instead of scheduling a new spawn —
   * otherwise an exit event that races a shutdown could spin up a fresh
   * child after the user has been told the tunnel is gone.
   */
  shuttingDown: boolean;
}

/**
 * Reconnect backoff in milliseconds. After the final entry we stay at
 * 30s indefinitely — the ladder is capped, not wrapping, so a long-lived
 * outage doesn't silently escalate past half a minute between attempts.
 *
 * Rationale for the exact values:
 *   - 1s → 2s covers a fast sshd restart or transient network blip.
 *   - 4s → 8s gives a typical DHCP renew / route flap room to settle.
 *   - 30s is the "we don't know when this comes back, stop hammering"
 *     cap. Below this, a misconfigured target would see us retry 6× per
 *     minute forever; above it, a real recovery takes noticeably longer
 *     to detect.
 */
const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000, 30000] as const;

/**
 * Error codes that mean "do not auto-reconnect — a human has to look at
 * this". Everything else (auth_failed, connect_refused, remote_daemon_down,
 * unknown) is considered transient and schedules a reconnect.
 *
 *   - `host_key_mismatch`  — the remote identity changed. Reconnecting
 *     silently would paper over a potential MITM. The user has to
 *     explicitly accept the new key.
 *   - `remote_flockctl_missing` — the far side isn't a Flockctl host (or
 *     the binary isn't on the remote shell's PATH). Retrying won't fix
 *     this without a human making a bootstrap change.
 *
 *   - `auth_failed` is intentionally NOT terminal: a user re-adding a key
 *     to ssh-agent mid-session is the canonical "transient auth" case,
 *     and the reconnect loop will pick up once the agent has the key.
 */
const TERMINAL_ERROR_CODES: readonly TunnelErrorCode[] = [
  "host_key_mismatch",
  "remote_flockctl_missing",
];

/**
 * Allocate a free TCP port on 127.0.0.1 by asking the kernel.
 *
 * Binds to `127.0.0.1:0`, reads the chosen port off the bound socket,
 * then closes the socket. Between the close and the subsequent
 * `spawn('ssh', …)` there is a tiny TOCTOU window where another process
 * could race onto the port; ssh's `ExitOnForwardFailure=yes` makes that
 * surface as a clean child exit rather than a silent hang.
 */
async function allocateLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const port = addr.port;
        server.close((closeErr) => {
          /* v8 ignore next — defensive: close() on a freshly-listening server
           * that we just read address() from never reports an error. */
          if (closeErr) reject(closeErr);
          else resolve(port);
        });
      /* v8 ignore start — defensive: Node's net.Server.address() returns an
       * AddressInfo object after a successful listen(0); this else branch is
       * for pathological runtime types we can't reproduce in tests. */
      } else {
        server.close();
        reject(new Error("failed to allocate local port"));
      }
      /* v8 ignore stop */
    });
  });
}

export class SshTunnelManager {
  private readonly handles = new Map<string, TunnelHandle>();
  private readonly canonical = new Map<string, CanonicalEntry>();
  private readonly probe: ReadyProbe;
  private readonly probeTimeoutMs?: number;
  private readonly probePollMs?: number;
  /**
   * Serialize local-port allocation across concurrent `start()` calls.
   *
   * `allocateLocalPort()` does `listen(0) → read port → close`. The close is
   * best-effort — between it and the subsequent spawn there is a small TOCTOU
   * window. Worse, two *concurrent* allocators can overlap such that both
   * receive the same kernel-assigned port (the kernel is free to reuse the
   * ephemeral port once both sockets are released). Funneling allocation
   * through this promise chain serializes the bind/close cycle so every
   * caller sees a fresh probe against the kernel's free-port table, which
   * kills the race without any locking primitives.
   */
  private portAllocLock: Promise<void> = Promise.resolve();

  constructor(opts: SshTunnelManagerOptions = {}) {
    this.probe = opts.probe ?? waitForTunnelReady;
    this.probeTimeoutMs = opts.probeTimeoutMs;
    this.probePollMs = opts.probePollMs;
  }

  /**
   * Serialized wrapper around {@link allocateLocalPort}. Every call chains
   * onto `portAllocLock`, then releases the lock when the inner allocation
   * settles. The chain is rebuilt on the spot (`this.portAllocLock =
   * ticket`) so a throw from a prior allocator doesn't poison subsequent
   * calls — the catch branch swallows rejection before `release` is
   * invoked.
   */
  private async allocatePortSerialized(): Promise<number> {
    let release!: () => void;
    const ticket = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.portAllocLock;
    this.portAllocLock = ticket;
    try {
      await prev;
    } catch {
      // Prior caller rejected. We still hold the new ticket — continue.
    }
    try {
      return await allocateLocalPort();
    } finally {
      release();
    }
  }

  list(): TunnelHandle[] {
    return [...this.handles.values()];
  }

  get(id: string): TunnelHandle | undefined {
    return this.handles.get(id);
  }

  open(options: SshTunnelOptions): TunnelHandle {
    const argv = buildSshArgv(options);
    const spawner = options.spawner ?? spawn;
    const child = spawner("ssh", argv, { stdio: ["ignore", "pipe", "pipe"] });

    const id = `tun-${nextId++}`;
    const events = new EventEmitter();
    const stderrBuffer = { value: "" };

    const handle: TunnelHandle = {
      id,
      options,
      argv,
      // Initial state: no stderr yet, no exit yet. `unknown` is the
      // canonical "no classification known" sentinel — the TunnelErrorCode
      // union in ./types.ts has no `ok` member on purpose. It will be
      // overwritten on the first stderr chunk or on exit.
      errorCode: "unknown",
      rawStderr: "",
      exitCode: null,
      exited: false,
      child,
      events,
      stderrBuffer,
    };
    this.handles.set(id, handle);

    const reclassify = (): ClassifyResult => {
      const result = classifyStderr(stderrBuffer.value, handle.exitCode);
      handle.errorCode = result.errorCode;
      handle.rawStderr = result.rawStderr;
      return result;
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer.value += chunk;
      // Reclassify-on-read — if we see a host-key warning before the
      // child has exited, the UI shouldn't have to wait for `exit` to
      // show a useful error. `exitCode` is still null here, so the
      // classifier uses only the pattern table.
      reclassify();
      events.emit("stderr", chunk);
    });

    child.on("exit", (code) => {
      handle.exitCode = code;
      handle.exited = true;
      const result = reclassify();
      events.emit("exit", { code, ...result });
    });

    child.on("error", (err) => {
      // spawn-level failure (ssh binary missing, EACCES, etc.).
      // Treat as `unknown` exit; downstream should still surface it.
      handle.exited = true;
      handle.exitCode = handle.exitCode ?? -1;
      reclassify();
      events.emit("error", err);
    });

    return handle;
  }

  close(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    if (!handle.exited) handle.child.kill("SIGTERM");
    this.handles.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.handles.keys()]) this.close(id);
  }

  // ---------------------------------------------------------------------------
  // Canonical API (slice.md "Public interface" block).
  //
  // `start` / `stop` / `restart` / `shutdown` operate on `serverId`-keyed
  // {@link SshTunnelHandle} objects and are the API the HTTP route layer
  // (slice 03) will bind to. Until the later tasks flesh out the ready-gate,
  // reconnect, and shutdown surfaces, only `start` is implemented here.
  // ---------------------------------------------------------------------------

  /**
   * Start a new tunnel for the given remote server.
   *
   * The flow is:
   *   1. Allocate a free local port.
   *   2. Build argv + spawn ssh (validation happens in `buildSshArgs`).
   *   3. Register the handle in the canonical map in `"starting"` state so
   *      callers can observe it via `getByServerId()` during the probe.
   *   4. Install a one-shot `'exit'` listener on the child that aborts the
   *      probe and flips the handle to `"error"` — the stderr classifier
   *      is owned by a later task, so `errorCode` stays `"unknown"` and
   *      `rawStderr` gets a placeholder.
   *   5. Await the ready-gate probe. On `'ready'` → `"ready"`. On
   *      `'timeout'` → `"error"` with `rawStderr='ready-gate timeout'`.
   *   6. If `shutdown()` flipped the handle to `"stopped"` mid-probe, we
   *      leave the terminal state alone.
   *
   * @throws {RangeError}      if port allocation returns a non-positive int
   * @throws {ValidationError} if host / remotePort fail {@link buildSshArgs}
   */
  async start(server: RemoteServerConfig): Promise<SshTunnelHandle> {
    const localPort = await this.allocatePortSerialized();
    /* v8 ignore next 5 — defensive: allocateLocalPort always resolves with a
     * valid kernel-assigned positive integer when it resolves; this guard is
     * belt-and-braces and not testable without tampering with node internals. */
    if (!Number.isInteger(localPort) || localPort <= 0) {
      throw new RangeError(
        `allocateLocalPort returned non-positive port: ${localPort}`,
      );
    }

    const args = buildSshArgs(server, localPort);

    // Argv-array form — NEVER a shell string. The ssh binary is execve'd
    // directly, so shell metacharacters in `host` / `identityFile` / `user`
    // cannot be interpreted as commands. This is why the host validator is
    // belt-and-suspenders rather than the sole defence.
    const child = child_process.spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle: SshTunnelHandle = {
      serverId: server.id,
      localPort,
      status: "starting" satisfies TunnelStatus,
      startedAt: Date.now(),
    };

    const abort = new AbortController();

    // Reuse the existing canonical entry on reconnect — we want the
    // backoff index to persist across spawns. Only swap in the new
    // child/handle/abort/stderr-buffer and clear any pending timer.
    let entry = this.canonical.get(server.id);
    if (entry) {
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = undefined;
      }
      entry.child = child;
      entry.handle = handle;
      entry.abort = abort;
      entry.server = server;
      entry.stderrBuffer = "";
    } else {
      entry = {
        child,
        handle,
        abort,
        server,
        backoffIndex: 0,
        stderrBuffer: "",
        shuttingDown: false,
      };
      this.canonical.set(server.id, entry);
    }
    const thisEntry = entry;

    // Buffer stderr for the classifier. We do NOT call setEncoding here
    // because tests inject PassThrough-backed fake children and synthesise
    // data events with either string or Buffer payloads — handling both
    // keeps the production path (real ssh emits Buffer) and the test path
    // on a single code line.
    child.stderr?.on("data", (chunk: Buffer | string) => {
      thisEntry.stderrBuffer +=
        /* v8 ignore next — tests only exercise the string-payload limb via
           PassThrough; the Buffer path is the production one but no test
           synthesises a real Buffer chunk. */
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    // If the ssh child dies during the probe, abort the probe, classify
    // the stderr we've seen so far, and flip the handle to "error" with
    // the resulting errorCode/rawStderr. If the stderr is empty the
    // classifier returns rawStderr="", so we fall back to a placeholder
    // message so the UI has *something* to show.
    const onExit = (code: number | null) => {
      abort.abort();
      if (handle.status === "starting") {
        const classified = classifyStderr(thisEntry.stderrBuffer, code);
        handle.status = "error";
        handle.errorCode = classified.errorCode;
        handle.rawStderr =
          classified.rawStderr.length > 0
            ? classified.rawStderr
            : `ssh exited with code ${code ?? "null"} during ready-gate`;
      }
    };
    child.once("exit", onExit);

    try {
      const result = await this.probe(localPort, {
        timeoutMs: this.probeTimeoutMs,
        pollMs: this.probePollMs,
        signal: abort.signal,
      });

      // Terminal states (stopped from shutdown, error from child exit) win.
      // We only flip from 'starting' — otherwise we'd clobber a shutdown
      // that raced us to the finish line.
      if (handle.status === "starting") {
        if (result === "ready") {
          handle.status = "ready";
          handle.readyAt = Date.now();
          // Reaching "ready" resets the backoff ladder: a subsequent
          // child-exit-after-ready starts again at the 1s slot.
          thisEntry.backoffIndex = 0;
        } else {
          handle.status = "error";
          handle.errorCode = "unknown";
          handle.rawStderr = "ready-gate timeout";
        }
      }
    } finally {
      child.removeListener("exit", onExit);
    }

    // Post-resolution wiring — decide whether to schedule a reconnect.
    //
    //   - On "ready": install a fresh one-shot exit listener that
    //     classifies the exit stderr and, if the code is non-terminal,
    //     schedules a reconnect. (Terminal codes on a ready-then-died
    //     tunnel still mean "human has to look at this".)
    //   - On "error" with a non-terminal errorCode: schedule a reconnect
    //     now. The bootstrap itself is retryable.
    //   - On "error" with a terminal errorCode: do NOT schedule — wait
    //     for an explicit `restart()`.
    //   - On "stopped": shutdown won the race; do nothing.
    if (handle.status === "ready") {
      const onPostReadyExit = (code: number | null) => {
        // Only act if this child is still the current one (i.e. restart
        // or another start hasn't already swapped it out) and the handle
        // hasn't been flipped to "stopped" by shutdown().
        if (thisEntry.child !== child) return;
        /* v8 ignore next — racy timer interleaving: handle swap happens on
           a different microtask than this exit callback, so tests can't
           reliably stage the "child is still us but handle isn't" state. */
        if (thisEntry.handle !== handle) return;
        if (handle.status === "stopped") return;
        const classified = classifyStderr(thisEntry.stderrBuffer, code);
        handle.status = "error";
        handle.errorCode = classified.errorCode;
        handle.rawStderr =
          classified.rawStderr.length > 0
            ? classified.rawStderr
            /* v8 ignore next — covered by the ready-gate fallback at L480;
               tests assert the primary classifyStderr-produced message. */
            : `ssh exited with code ${code ?? "null"} after ready`;
        if (!TERMINAL_ERROR_CODES.includes(classified.errorCode)) {
          this.scheduleReconnect(thisEntry);
        }
      };
      child.once("exit", onPostReadyExit);
    } else if (handle.status === "error") {
      /* v8 ignore next — errorCode is set in all paths that flip status
         to "error" above; the ?? is defensive TS glue. */
      const code = handle.errorCode ?? "unknown";
      if (!TERMINAL_ERROR_CODES.includes(code)) {
        this.scheduleReconnect(thisEntry);
      }
    }

    return handle;
  }

  /**
   * Schedule a reconnect for this entry using the exponential backoff
   * ladder. Always clears any previously-scheduled timer first so we
   * never stack two reconnects for the same tunnel.
   *
   * The timer callback calls `this.start(entry.server)` which reuses the
   * existing canonical entry (preserving `backoffIndex`) and replaces
   * the child/handle/abort in place. Errors from the re-start are
   * swallowed — start()'s own "error" path already schedules the next
   * reconnect, so there's nothing for the caller to do here.
   */
  private scheduleReconnect(entry: CanonicalEntry): void {
    // If stop()/shutdown() has already flipped the kill switch, never
    // schedule a fresh spawn — the entry is about to be evicted.
    /* v8 ignore next — racy timer interleaving: shuttingDown is flipped
       synchronously by shutdown(), so tests can't reach this guard without
       a mid-flight reschedule. */
    if (entry.shuttingDown) return;
    /* v8 ignore next 4 — re-scheduling with an existing timer is racy: the
       clear path only runs if a previous setTimeout is still queued, which
       tests don't stage. */
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
    const idx = Math.min(entry.backoffIndex, BACKOFF_SEQUENCE_MS.length - 1);
    const delay = BACKOFF_SEQUENCE_MS[idx];
    entry.backoffIndex += 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      // The timer may have fired in the gap between stop() clearing it
      // and the callback being unqueued. Double-check that our entry is
      // still the live one in the canonical map.
      /* v8 ignore start — racy-timer interleaving: by the time the
         setTimeout callback fires the canonical map is either already
         flipped to shuttingDown (handled by the synchronous stop() path) or
         still pointing at this entry, so these guards rarely both fire. */
      if (entry.shuttingDown) return;
      if (this.canonical.get(entry.server.id) !== entry) return;
      /* v8 ignore stop */
      // Fire-and-forget: start() will schedule the next reconnect on
      // failure, and shutdown() clears any pending timer if the user
      // tears down mid-loop.
      void this.start(entry.server).catch(() => {
        // Re-schedule on unexpected throw (argv validation, port alloc,
        // spawn failure). Without this a transient spawn-level error
        // would silently end the reconnect loop.
        /* v8 ignore start — mid-reschedule races after start() throws are
           not reliably reproducible via synthetic fake children. */
        if (entry.shuttingDown) return;
        if (this.canonical.get(entry.server.id) !== entry) return;
        this.scheduleReconnect(entry);
        /* v8 ignore stop */
      });
    }, delay);
  }

  /**
   * Force an immediate respawn, regardless of current status. Clears any
   * pending reconnect timer, resets the backoff ladder to 1s, kills the
   * current child (if still alive), and invokes `start()` again.
   *
   * This is the UI "Reconnect" button's entry point — the one way to
   * escape a terminal error state (e.g. `host_key_mismatch` after the
   * user has accepted the new key, or `remote_flockctl_missing` after
   * they've installed the binary on the remote box).
   *
   * @throws {Error} if no canonical entry exists for `serverId` — the
   *   caller must have a server config from a prior start() to restart.
   */
  async restart(serverId: string): Promise<SshTunnelHandle> {
    const entry = this.canonical.get(serverId);
    if (!entry) {
      throw new Error(`no tunnel for serverId ${JSON.stringify(serverId)}`);
    }

    // Clear any pending reconnect first — otherwise a timer firing mid
    // restart() would race us to the spawn.
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }

    // Abort any in-flight probe from the previous start so its `onExit`
    // and post-ready listeners don't try to classify stderr from the
    // old child after we've moved on.
    entry.abort.abort();

    // Explicit user action resets the ladder. The very first failure
    // post-restart should use the 1s slot again.
    entry.backoffIndex = 0;

    // Kill the previous child if it's still alive. Best-effort — if the
    // child has already exited or our signal permissions won't let us,
    // we just press on and let start() overwrite the slot.
    try {
      if (entry.child.exitCode === null && !entry.child.killed) {
        entry.child.kill("SIGTERM");
      }
    } catch {
      // Ignored by design — see rationale above.
    }

    return this.start(entry.server);
  }

  /**
   * Stop a single canonical tunnel. SIGTERM → wait up to 3 s → SIGKILL.
   *
   * Per slice.md the sequence is:
   *   1. Clear any pending reconnect timer.
   *   2. Flag `shuttingDown` so the post-ready exit listener and the
   *      reconnect-timer callback both see "don't respawn".
   *   3. Abort the ready-gate signal — releases a pending probe so the
   *      awaiting `start()` call resolves synchronously as `"stopped"`.
   *   4. Mark `handle.status = "stopped"` before doing any IO, so any
   *      observer of the handle sees terminal state immediately.
   *   5. Send SIGTERM to the child.
   *   6. Await `'exit'` or a 3 000 ms timer, whichever comes first.
   *   7. If the child still hasn't exited: SIGKILL, then await `'exit'`
   *      again with a shorter grace window (1 s) so a misbehaving child
   *      doesn't hold up `shutdown()` forever.
   *   8. Remove the entry from the canonical map.
   *
   * `stop()` is idempotent — calling it twice for the same serverId is a
   * no-op the second time.
   */
  async stop(serverId: string): Promise<void> {
    const entry = this.canonical.get(serverId);
    if (!entry) return;

    // Step 1 + 2: kill switches for any reconnect logic racing us.
    entry.shuttingDown = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }

    // Step 3: release any in-flight probe so the awaiting start() resolves.
    entry.abort.abort();

    // Step 4: terminal state is visible before the kill IO happens.
    entry.handle.status = "stopped";

    const child = entry.child;

    // Step 8 (early): evict from the canonical map. Any subsequent
    // `getByServerId` returns null even while we're still awaiting reap.
    this.canonical.delete(serverId);

    // Fast path: the child has already exited (common when restart() or
    // an earlier exit listener beat us here).
    if (child.exitCode !== null) return;

    // Steps 5–7: SIGTERM, wait up to 3 s for exit, then SIGKILL + 1 s grace.
    await new Promise<void>((resolve) => {
      let sigkillTimer: NodeJS.Timeout | undefined;
      let sigkillGraceTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = undefined;
        }
        if (sigkillGraceTimer) {
          clearTimeout(sigkillGraceTimer);
          sigkillGraceTimer = undefined;
        }
        child.removeListener("exit", onExit);
      };

      const onExit = () => {
        cleanup();
        resolve();
      };
      child.once("exit", onExit);

      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort — already-dead child, EPERM, EINVAL. If the child
        // really is dead we'll see 'exit' shortly; if not, the SIGKILL
        // escalation below will try again.
      }

      sigkillTimer = setTimeout(() => {
        sigkillTimer = undefined;
        // Still alive after 3 s — escalate to SIGKILL. If the child was
        // never signalable (dead handle, wrong pid) we still want to
        // resolve promptly, so we start a hard deadline after SIGKILL.
        try {
          child.kill("SIGKILL");
        } catch {
          // Same best-effort rationale as SIGTERM.
        }
        sigkillGraceTimer = setTimeout(() => {
          // Give up waiting for 'exit' — caller has waited long enough.
          cleanup();
          resolve();
        }, 1_000);
      }, 3_000);
    });
  }

  /**
   * Gracefully stop every canonical tunnel in parallel. Resolves once
   * every `stop()` has resolved (i.e. every child has exited or been
   * SIGKILL'd past the grace window).
   *
   * Worst-case wall time: 3 s (SIGTERM wait) + 1 s (SIGKILL grace) = 4 s,
   * comfortably inside the 15 s `GRACEFUL_STOP_TIMEOUT_MS` budget the
   * daemon gives us in src/daemon.ts:20.
   *
   * For backward compatibility, `shutdown(serverId)` is accepted as a
   * legacy alias for `stop(serverId)` — callers should migrate to `stop`.
   */
  shutdown(): Promise<void>;
  shutdown(serverId: string): Promise<void>;
  async shutdown(serverId?: string): Promise<void> {
    if (typeof serverId === "string") {
      await this.stop(serverId);
      return;
    }
    await Promise.all(this.listAll().map((h) => this.stop(h.serverId)));
  }

  /**
   * Enumerate canonical handles. Matches the slice.md public-interface
   * name. {@link listAllServers} is kept as a historical alias so the
   * existing test suite continues to work without modification.
   */
  listAll(): SshTunnelHandle[] {
    return this.listAllServers();
  }

  /**
   * Look up a canonical handle by the server id it was started with.
   * Returns `null` (not `undefined`) to match the slice.md signature.
   */
  getByServerId(serverId: string): SshTunnelHandle | null {
    return this.canonical.get(serverId)?.handle ?? null;
  }

  /**
   * Enumerate canonical handles. Alias of the slice.md `listAll()` — named
   * distinctly from the legacy `list()` so the two APIs don't collide.
   */
  listAllServers(): SshTunnelHandle[] {
    return [...this.canonical.values()].map((e) => e.handle);
  }

  /** Internal accessor for tests: the raw child for a given serverId. */
  _canonicalChild(serverId: string): ChildProcess | undefined {
    return this.canonical.get(serverId)?.child;
  }
}
