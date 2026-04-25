/**
 * Tests for `sshExec` — the argv-only ssh runner used by the remote-
 * bootstrap flow.
 *
 * Test surface:
 *   1. `baseFlags()` emits exactly the documented option block (and
 *      does NOT include `-N` or `-L`, which are tunnel-only).
 *   2. `sshExec` spawns `ssh` with `[...baseFlags(), [-p X], [-i Y],
 *      <host>, ...userArgv]` in that order, and NEVER with `shell:
 *      true`.
 *   3. Input validation rejects empty argv, non-string elements,
 *      control characters (newline injection), and pathological hosts.
 *      Validation failures must NEVER reach `spawn`.
 *   4. stdout/stderr are captured as UTF-8 strings; non-zero exit
 *      codes are surfaced as-is; null exit codes (signal death) are
 *      coerced to -1.
 *   5. Timeout behaviour: default 10 s; caller override; SIGKILL
 *      delivery on elapse; `SshExecTimeout` rejection carrying the
 *      effective timeout; no timeout firing when the child exits
 *      in time.
 *
 * Ref: docs/TESTING.md — unit-tier tests never bind real sockets.
 * Spawn is swapped for a vi.fn via the ESM namespace-mock pattern the
 * rest of this folder already uses (build-args.test.ts, ready-gate.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import type * as child_process from "node:child_process";
import {
  DEFAULT_SSH_EXEC_TIMEOUT_MS,
  baseFlags,
  buildExecArgv,
  sshExec,
  SshExecTimeout,
} from "../../../services/ssh-tunnels/ssh-exec.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";
import { ValidationError } from "../../../lib/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ChildProcess stub: an EventEmitter with piped stdout/stderr and a
 * spy-able `kill`. Matches the shape the other tests in this folder
 * use so the behaviour under test exercises the same code path.
 */
function makeFakeChild() {
  const e = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: null;
    kill: (sig?: NodeJS.Signals | number) => boolean;
    killed: boolean;
    exitCode: number | null;
    pid?: number;
  };
  e.stdout = new PassThrough();
  e.stderr = new PassThrough();
  e.stdin = null;
  e.killed = false;
  e.exitCode = null;
  e.kill = function kill(_sig?: NodeJS.Signals | number) {
    this.killed = true;
    return true;
  };
  e.pid = 5151;
  return e;
}

function mkServer(
  overrides: Partial<RemoteServerConfig["ssh"]> = {},
): RemoteServerConfig {
  return { id: "srv-1", name: "srv-1", ssh: { host: "example.com", ...overrides } };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// baseFlags
// ---------------------------------------------------------------------------

describe("baseFlags", () => {
  it("emits the exact option block (order-sensitive)", () => {
    expect(baseFlags()).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
    ]);
  });

  it("does NOT include tunnel-only -N / -L (sshExec runs commands, not tunnels)", () => {
    expect(baseFlags()).not.toContain("-N");
    expect(baseFlags()).not.toContain("-L");
  });

  it("returns a fresh array each call — callers can mutate the result safely", () => {
    const a = baseFlags();
    const b = baseFlags();
    expect(a).not.toBe(b);
    a.push("mutated");
    expect(b).not.toContain("mutated");
  });
});

// ---------------------------------------------------------------------------
// buildExecArgv — argv assembly
// ---------------------------------------------------------------------------

describe("buildExecArgv — argv shape", () => {
  it("minimal: baseFlags → host → caller argv", () => {
    expect(buildExecArgv(mkServer(), ["echo", "hi"])).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "example.com",
      "echo",
      "hi",
    ]);
  });

  it("matches the bootstrap argv shape from the task spec (user, port, identity)", () => {
    const server = mkServer({
      host: "box.example.com",
      user: "alice",
      port: 2222,
      identityFile: "/home/me/.ssh/id_ed25519",
    });
    const argv = buildExecArgv(server, [
      "flockctl",
      "remote-bootstrap",
      "--print-token",
      "--label",
      "laptop",
    ]);
    expect(argv).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "-i",
      "/home/me/.ssh/id_ed25519",
      "alice@box.example.com",
      "flockctl",
      "remote-bootstrap",
      "--print-token",
      "--label",
      "laptop",
    ]);
  });

  it("omits -p when port is undefined", () => {
    const argv = buildExecArgv(mkServer(), ["echo"]);
    expect(argv).not.toContain("-p");
  });

  it("omits -p when port === 22 (the default)", () => {
    const argv = buildExecArgv(mkServer({ port: 22 }), ["echo"]);
    expect(argv).not.toContain("-p");
  });

  it("includes -p when port !== 22", () => {
    const argv = buildExecArgv(mkServer({ port: 2222 }), ["echo"]);
    const i = argv.indexOf("-p");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("2222");
  });

  it("omits -i when identityFile is undefined", () => {
    const argv = buildExecArgv(mkServer(), ["echo"]);
    expect(argv).not.toContain("-i");
  });

  it("includes -i with the path verbatim (argv-array safety — no shell)", () => {
    const weird = "/tmp/dir with spaces/id$rsa`";
    const argv = buildExecArgv(mkServer({ identityFile: weird }), ["echo"]);
    const i = argv.indexOf("-i");
    expect(argv[i + 1]).toBe(weird);
  });

  it("leaves host untouched when user is undefined (supports ~/.ssh/config aliases)", () => {
    const argv = buildExecArgv(mkServer({ host: "prod-alias" }), ["echo"]);
    // Host token sits immediately before the caller argv.
    const hostIdx = argv.indexOf("prod-alias");
    expect(hostIdx).toBeGreaterThan(0);
    expect(argv[hostIdx + 1]).toBe("echo");
  });

  it("prepends user@ when user is set", () => {
    const argv = buildExecArgv(
      mkServer({ host: "box.example.com", user: "alice" }),
      ["echo"],
    );
    expect(argv).toContain("alice@box.example.com");
  });

  it("passes user argv elements verbatim — no re-quoting, no splitting", () => {
    const argv = buildExecArgv(mkServer(), [
      "flockctl",
      "--label",
      "laptop-1",
    ]);
    expect(argv.slice(-3)).toEqual(["flockctl", "--label", "laptop-1"]);
  });
});

describe("buildExecArgv — input validation", () => {
  it("rejects empty argv", () => {
    expect(() => buildExecArgv(mkServer(), [])).toThrow(ValidationError);
  });

  it("rejects non-array argv", () => {
    expect(() =>
      buildExecArgv(mkServer(), null as unknown as string[]),
    ).toThrow(ValidationError);
  });

  it("rejects non-string argv element", () => {
    expect(() =>
      buildExecArgv(mkServer(), [42 as unknown as string]),
    ).toThrow(ValidationError);
  });

  it("rejects empty-string argv element", () => {
    expect(() => buildExecArgv(mkServer(), [""])).toThrow(ValidationError);
  });

  it("rejects argv element with embedded newline (injection vector)", () => {
    expect(() =>
      buildExecArgv(mkServer(), ["flockctl", "--label\nevil"]),
    ).toThrow(/control characters/);
  });

  it("rejects argv element with NUL / DEL / ESC", () => {
    for (const bad of ["\x00", "a\x7fb", "\x1b[31m"]) {
      expect(() => buildExecArgv(mkServer(), [bad])).toThrow(/control characters/);
    }
  });

  it("rejects pathological host (propagates validateSshHost)", () => {
    expect(() =>
      buildExecArgv({ id: "x", name: "x", ssh: { host: "$(rm -rf /)" } }, [
        "echo",
      ]),
    ).toThrow(/invalid host/);
  });

  it("rejects invalid port", () => {
    expect(() => buildExecArgv(mkServer({ port: 0 }), ["echo"])).toThrow(
      ValidationError,
    );
    expect(() => buildExecArgv(mkServer({ port: 70000 }), ["echo"])).toThrow(
      ValidationError,
    );
  });

  it("rejects identityFile with control chars", () => {
    expect(() =>
      buildExecArgv(mkServer({ identityFile: "/tmp/id\nbad" }), ["echo"]),
    ).toThrow(/control characters/);
  });

  it("rejects empty identityFile string", () => {
    expect(() =>
      buildExecArgv(mkServer({ identityFile: "" }), ["echo"]),
    ).toThrow(ValidationError);
  });

  it("rejects user with shell metacharacters", () => {
    expect(() =>
      buildExecArgv(mkServer({ user: "al;ice" }), ["echo"]),
    ).toThrow(ValidationError);
  });

  it("rejects empty user string", () => {
    expect(() => buildExecArgv(mkServer({ user: "" }), ["echo"])).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// sshExec — spawn plumbing
// ---------------------------------------------------------------------------

describe("sshExec — spawn call shape", () => {
  it("calls spawn('ssh', buildExecArgv(...), stdio piped) without shell:true", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const server = mkServer({ port: 2222, identityFile: "/k" });
    const argv = ["flockctl", "remote-bootstrap", "--print-token", "--label", "work"];
    const p = sshExec(server, argv);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, passedArgv, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("ssh");
    expect(passedArgv).toEqual(buildExecArgv(server, argv));
    expect(opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    // Crucial: no shell. argv-only means no /bin/sh -c joining.
    expect((opts as { shell?: unknown }).shell).toBeFalsy();

    fake.emit("exit", 0);
    await p;
  });

  it("does NOT call spawn when validation fails (empty argv)", async () => {
    await expect(sshExec(mkServer(), [])).rejects.toBeInstanceOf(ValidationError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT call spawn when validation fails (bad host)", async () => {
    await expect(
      sshExec({ id: "x", name: "x", ssh: { host: "$(rm -rf /)" } }, ["echo"]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT call spawn when argv has a control character", async () => {
    await expect(
      sshExec(mkServer(), ["flockctl", "--label\nevil"]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sshExec — stdout / stderr / exitCode capture
// ---------------------------------------------------------------------------

describe("sshExec — output capture", () => {
  it("captures stdout as a UTF-8 string across multiple data events", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const p = sshExec(mkServer(), ["echo"]);
    fake.stdout.write("hello\n");
    fake.stdout.write("world\n");
    fake.emit("exit", 0);

    const res = await p;
    expect(res.stdout).toBe("hello\nworld\n");
    expect(res.exitCode).toBe(0);
  });

  it("captures stderr independently from stdout", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const p = sshExec(mkServer(), ["echo"]);
    fake.stdout.write("OUT");
    fake.stderr.write("ERR");
    fake.emit("exit", 0);

    const res = await p;
    expect(res.stdout).toBe("OUT");
    expect(res.stderr).toBe("ERR");
  });

  it("returns non-zero exit codes verbatim (e.g. 127 remote-not-found)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const p = sshExec(mkServer(), ["flockctl"]);
    fake.emit("exit", 127);
    const res = await p;
    expect(res.exitCode).toBe(127);
  });

  it("coerces null exit code to -1 (child killed by signal w/o timeout)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const p = sshExec(mkServer(), ["echo"]);
    fake.emit("exit", null);
    const res = await p;
    expect(res.exitCode).toBe(-1);
  });

  it("rejects if the child process emits 'error' (e.g. ssh binary missing)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const p = sshExec(mkServer(), ["echo"]);
    fake.emit("error", new Error("spawn ssh ENOENT"));
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it("is resilient to stdout arriving after exit — buffers what was already emitted", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const p = sshExec(mkServer(), ["echo"]);
    fake.stdout.write("data-before-exit");
    fake.emit("exit", 0);
    // Writes after exit are ignored because the listener fired and the
    // promise settled. (This mirrors the real-world guarantee: child
    // closes its stdout before 'exit' fires.)
    const res = await p;
    expect(res.stdout).toBe("data-before-exit");
  });
});

// ---------------------------------------------------------------------------
// sshExec — timeout behavior
// ---------------------------------------------------------------------------

describe("sshExec — timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("default timeout is 10s (DEFAULT_SSH_EXEC_TIMEOUT_MS)", () => {
    expect(DEFAULT_SSH_EXEC_TIMEOUT_MS).toBe(10_000);
  });

  it("SIGKILLs the child once the default timeout elapses and rejects with SshExecTimeout", async () => {
    const fake = makeFakeChild();
    const killSpy = vi.spyOn(fake, "kill");
    spawnMock.mockReturnValue(fake);

    const p = sshExec(mkServer(), ["echo"]);
    // Swallow the rejection immediately so the fake child's 'exit'
    // emit later doesn't race settlement.
    const rejection = p.catch((e) => e);

    await vi.advanceTimersByTimeAsync(DEFAULT_SSH_EXEC_TIMEOUT_MS);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");

    // Child reaps shortly after SIGKILL — mirror that so the listener
    // path (which checks `timedOut`) runs.
    fake.emit("exit", null);
    const err = await rejection;
    expect(err).toBeInstanceOf(SshExecTimeout);
    expect((err as SshExecTimeout).timeoutMs).toBe(DEFAULT_SSH_EXEC_TIMEOUT_MS);
  });

  it("honours caller-supplied timeoutMs", async () => {
    const fake = makeFakeChild();
    const killSpy = vi.spyOn(fake, "kill");
    spawnMock.mockReturnValue(fake);

    const p = sshExec(mkServer(), ["echo"], { timeoutMs: 500 });
    const rejection = p.catch((e) => e);

    await vi.advanceTimersByTimeAsync(499);
    expect(killSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");

    fake.emit("exit", null);
    const err = await rejection;
    expect(err).toBeInstanceOf(SshExecTimeout);
    expect((err as SshExecTimeout).timeoutMs).toBe(500);
  });

  it("does NOT fire timeout when the child exits in time", async () => {
    const fake = makeFakeChild();
    const killSpy = vi.spyOn(fake, "kill");
    spawnMock.mockReturnValue(fake);

    const p = sshExec(mkServer(), ["echo"], { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);
    fake.emit("exit", 0);
    // Advance well past the original deadline — the timer is cleared
    // on exit, so no extra kill should fire.
    await vi.advanceTimersByTimeAsync(5_000);

    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("name and errorCode on SshExecTimeout are stable (UI / log hooks rely on them)", () => {
    const err = new SshExecTimeout(7_500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SshExecTimeout");
    expect(err.errorCode).toBe("ssh_exec_timeout");
    expect(err.timeoutMs).toBe(7_500);
    expect(err.message).toContain("7500");
  });
});

// ---------------------------------------------------------------------------
// Argv-as-data shell safety
// ---------------------------------------------------------------------------

describe("sshExec — argv_shape_never_interpolated_by_shell", () => {
  it("control characters in argv are rejected client-side (defence in depth)", async () => {
    // OpenSSH re-joins trailing argv on the server with `/bin/sh -c`,
    // so a newline in an argv element would split the remote command.
    // validateArgvElement rejects it before spawn is even considered.
    for (const bad of ["a\nb", "a\rb", "a\x00b"]) {
      spawnMock.mockReset();
      await expect(sshExec(mkServer(), ["flockctl", bad])).rejects.toThrow(
        /control characters/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it("passes benign shell-metacharacter-adjacent tokens through unchanged (no quoting)", async () => {
    // Characters like dots, dashes, slashes, and colons are legitimate
    // and must NOT trigger rejection — we only block control chars.
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const argv = ["flockctl", "--label", "prod-1.ssh", "--path=/etc/foo:bar"];
    const p = sshExec(mkServer(), argv);
    const passed = spawnMock.mock.calls[0]![1] as string[];
    expect(passed.slice(-4)).toEqual(argv);
    fake.emit("exit", 0);
    await p;
  });
});
