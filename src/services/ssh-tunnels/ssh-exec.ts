/**
 * `sshExec` — argv-only runner for one-shot ssh remote commands.
 *
 * Used by the remote-servers flow to execute a bounded command on the
 * far side (today: `flockctl remote-bootstrap --print-token --label …`).
 * The tunnel manager owns long-lived `ssh -N -L …` forwarders; this
 * helper owns the short-lived "exec a command and capture its stdout"
 * shape. The two surfaces deliberately share only the *base* -o flags
 * (batch mode, host-key auto-accept, server alive, connect-timeout) and
 * nothing else: -N / -L are tunnel-only.
 *
 * Argv shape for a bootstrap call (verified by test):
 *
 *   ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
 *       -o ConnectTimeout=10 \
 *       [-p <port>] [-i <identityFile>] <host> \
 *       flockctl remote-bootstrap --print-token --label <label>
 *
 * ------
 *  Why argv-only?
 * ------
 * When ssh executes a remote command, OpenSSH re-joins the trailing
 * argv on the server side and hands the resulting string to
 * `/bin/sh -c`. So `--label 'weird value'` leaves this host as two
 * argv elements and arrives on the remote as `--label weird value` —
 * two *shell tokens* — which would corrupt the label. The caller is
 * expected to reject label-like inputs with regex `^[A-Za-z0-9._-]+$`
 * before handing them to sshExec; this helper's own validation is the
 * defence-in-depth backstop that rejects control characters in any
 * argv element (newline injection is the worst offender).
 *
 * The spawn call NEVER sets `shell: true`, so the local side does no
 * shell interpretation either — argv elements are execve'd verbatim.
 *
 * ------
 *  Timeout semantics
 * ------
 * Every call is bounded. The default timeout is 10 s (comfortable cap
 * for `flockctl remote-bootstrap --print-token`, which is IO-light on
 * a healthy host). On timeout we SIGKILL the child — not SIGTERM —
 * because a hung ssh that's stuck mid-handshake won't respond to
 * polite signals. The awaiting caller receives `SshExecTimeout`.
 *
 * ------
 *  Log hygiene
 * ------
 * The returned `stderr` is handed back to the caller verbatim, but
 * callers MUST NOT log it at `info` level: ssh's error messages often
 * contain filesystem paths (`~/.ssh/id_ed25519`) and sometimes remote
 * usernames. Log at `warn` with a bounded tail instead.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { ValidationError } from "../../lib/errors.js";
import { validateSshHost, validatePort } from "./build-args.js";
import type { RemoteServerConfig } from "./types.js";

export class SshExecTimeout extends Error {
  readonly errorCode = "ssh_exec_timeout" as const;
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`ssh command did not finish within ${timeoutMs}ms`);
    this.name = "SshExecTimeout";
    this.timeoutMs = timeoutMs;
  }
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshExecOptions {
  /**
   * Upper bound on the child's wall-clock runtime. On hit, we SIGKILL
   * the child and reject with {@link SshExecTimeout}. Defaults to
   * {@link DEFAULT_SSH_EXEC_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * Test-only: override `child_process.spawn`. Production callers must
   * leave this undefined so we execve the real `ssh`.
   */
  spawner?: typeof spawn;
}

/** 10 s — see module-level rationale. */
export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 10_000;

/**
 * The fixed -o option block emitted at the head of every sshExec argv.
 * Mirrors the "shared with tunnel manager" baseline in the slice spec —
 * deliberately *not* including `-N` / `-L`, which are tunnel-only, and
 * adding `ConnectTimeout=10` so a TCP black-hole can't stall the whole
 * timeout budget on the handshake.
 *
 * Exported so the matching test file can assert on it symbolically
 * rather than pinning to a hard-coded literal.
 */
export function baseFlags(): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
}

/**
 * Validate a single argv element. We refuse non-strings, empty strings,
 * and anything with ASCII control characters (NUL, newline, DEL, …).
 *
 * Newlines in particular are the one thing that can survive OpenSSH's
 * server-side `sh -c` re-join and corrupt the remote command stream; a
 * client-side reject here stops that class of bug dead.
 */
function validateArgvElement(v: unknown, idx: number): asserts v is string {
  if (typeof v !== "string") {
    throw new ValidationError(
      `invalid argv[${idx}]: must be a string, got ${typeof v}`,
    );
  }
  if (v.length === 0) {
    throw new ValidationError(`invalid argv[${idx}]: must not be empty`);
  }
   
  if (/[\x00-\x1F\x7F]/.test(v)) {
    throw new ValidationError(
      `invalid argv[${idx}]: contains control characters`,
    );
  }
}

/**
 * Build the full argv (sans the program name) that we hand to spawn.
 *
 * Exported for tests so the argv shape can be asserted on without
 * actually spawning ssh. Production callers should use {@link sshExec}.
 */
export function buildExecArgv(
  server: RemoteServerConfig,
  userArgv: string[],
): string[] {
  if (!Array.isArray(userArgv) || userArgv.length === 0) {
    throw new ValidationError("sshExec: argv must be a non-empty string[]");
  }
  userArgv.forEach(validateArgvElement);

  const { host, user, port, identityFile } = server.ssh;
  validateSshHost(host);

  if (port !== undefined && port !== 22) {
    validatePort(port, "ssh port");
  }

  if (identityFile !== undefined) {
    if (typeof identityFile !== "string" || identityFile.length === 0) {
      throw new ValidationError("invalid identityFile: must be a non-empty string");
    }
     
    if (/[\x00-\x1F\x7F]/.test(identityFile)) {
      throw new ValidationError(
        "invalid identityFile: contains control characters",
      );
    }
  }

  if (user !== undefined) {
    if (typeof user !== "string" || user.length === 0) {
      throw new ValidationError("invalid user: must be a non-empty string");
    }
    if (!/^[A-Za-z0-9_.\-]+$/.test(user)) {
      throw new ValidationError(`invalid user: ${JSON.stringify(user)}`);
    }
  }

  const args: string[] = [...baseFlags()];

  // -p only when port is set and != 22 (matches buildSshArgs).
  if (port !== undefined && port !== 22) {
    args.push("-p", String(port));
  }

  // -i only when identityFile is set.
  if (identityFile !== undefined) {
    args.push("-i", identityFile);
  }

  // Host (possibly user@host) — always the last token before the
  // remote-command argv. ssh interprets everything AFTER the host as
  // the command to execute on the remote side.
  args.push(user !== undefined ? `${user}@${host}` : host);

  // Append the caller-supplied remote command argv. Each element is a
  // distinct argv slot — no re-quoting, no interpolation.
  for (const a of userArgv) args.push(a);

  return args;
}

/**
 * Run a one-shot command on `server` over ssh and capture its stdout /
 * stderr / exitCode.
 *
 * Contract:
 *   - Argv is validated; invalid input → `Promise.reject(ValidationError)`.
 *   - Child is spawned argv-only (NO `shell: true`). Stdin is closed,
 *     stdout/stderr are piped and buffered to UTF-8 strings.
 *   - On child exit: resolve with `{stdout, stderr, exitCode}`. A null
 *     exit code (signal-killed child, no timeout fired) is coerced to
 *     `-1` so callers can rely on `exitCode` being a number.
 *   - On timeout: SIGKILL the child, reject with {@link SshExecTimeout}.
 *   - On spawn-level error (e.g. ssh binary missing): reject with the
 *     underlying `Error`.
 *
 * @throws {ValidationError} via rejection — any bad input.
 * @throws {SshExecTimeout}  via rejection — timeout elapsed.
 */
export async function sshExec(
  server: RemoteServerConfig,
  argv: string[],
  opts: SshExecOptions = {},
): Promise<SshExecResult> {
  const fullArgv = buildExecArgv(server, argv);
  const spawner = opts.spawner ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS;

  return new Promise<SshExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawner("ssh", fullArgv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // Synchronous spawn failure (very rare — usually only EACCES on
      // the ssh binary). Surface as rejection so the helper's one and
      // only return channel is the Promise.
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort: the child may have already exited between the
        // event-loop tick that scheduled this callback and it firing.
      }
    }, timeoutMs);

    child.once("exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new SshExecTimeout(timeoutMs));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    child.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err);
    });
  });
}
