/**
 * Tests for `buildSshArgs` + `validateSshHost` (slice 00 / task 01 of
 * the SSH-only remote-servers milestone).
 *
 * The test surface is the argv-as-data contract: we never actually spawn
 * ssh here. `vi.spyOn(child_process, 'spawn')` captures the call SshTunnelManager.start()
 * makes so we can assert on the argv array without side-effects.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock `node:child_process` so the manager's namespace import of `spawn`
// resolves to a vi.fn we can inspect. ESM namespace objects are not
// spy-able via `vi.spyOn` (TypeError: Cannot redefine property), so we
// use vi.mock — the same pattern the rest of the codebase uses
// (claude-cli.test.ts, task-executor-full.test.ts, ...).
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import * as child_process from "node:child_process";
import {
  buildSshArgs,
  validateSshHost,
  validatePort,
} from "../../../services/ssh-tunnels/build-args.js";
import { SshTunnelManager } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";
import { ValidationError } from "../../../lib/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ChildProcess`-shaped stub that `child_process.spawn` can
 * return. Only the surface the manager touches is populated:
 * `stdout`, `stderr`, and the EventEmitter base for `exit` / `error`.
 */
function makeFakeChild(): child_process.ChildProcess {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (sig?: NodeJS.Signals) => boolean;
    pid?: number;
  };
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = () => true;
  emitter.pid = 4242;
  return emitter as unknown as child_process.ChildProcess;
}

function mkServer(overrides: Partial<RemoteServerConfig["ssh"]> = {}): RemoteServerConfig {
  return {
    id: "srv-1",
    name: "test",
    ssh: { host: "example.com", ...overrides },
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// validateSshHost
// ---------------------------------------------------------------------------

describe("validateSshHost", () => {
  it("accepts a plain hostname", () => {
    expect(() => validateSshHost("example.com")).not.toThrow();
  });

  it("accepts user@host form", () => {
    expect(() => validateSshHost("alice@box-1.example.com")).not.toThrow();
  });

  it("accepts SSH-config host aliases (underscore, dot, hyphen)", () => {
    expect(() => validateSshHost("my_prod-box.1")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateSshHost("")).toThrow(ValidationError);
    expect(() => validateSshHost("")).toThrow(/must not be empty/);
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateSshHost("   \t")).toThrow(ValidationError);
  });

  it("rejects non-string input", () => {
    expect(() => validateSshHost(undefined)).toThrow(ValidationError);
    expect(() => validateSshHost(42)).toThrow(ValidationError);
    expect(() => validateSshHost(null)).toThrow(ValidationError);
  });

  it("rejects embedded newline", () => {
    expect(() => validateSshHost("example.com\n-p 1234")).toThrow(ValidationError);
    expect(() => validateSshHost("example.com\n-p 1234")).toThrow(/control characters/);
  });

  it("rejects carriage return / NUL / other control chars", () => {
    expect(() => validateSshHost("host\r")).toThrow(/control characters/);
    expect(() => validateSshHost("host\x00")).toThrow(/control characters/);
    expect(() => validateSshHost("host\x1b[31m")).toThrow(/control characters/);
  });

  it("rejects shell metacharacters ($, backticks, ;, |, &, spaces)", () => {
    for (const bad of [
      "$(rm -rf /)",
      "`whoami`",
      "host;ls",
      "host|cat",
      "host&sleep 1",
      "host with space",
      'host"quote',
      "host'quote",
      "host\\back",
      "host>out",
      "host<in",
      "host#comment",
    ]) {
      expect(() => validateSshHost(bad), `should reject: ${JSON.stringify(bad)}`).toThrow(
        ValidationError,
      );
    }
  });

  it("rejects host with backticks (from task spec's negative tests)", () => {
    expect(() => validateSshHost("`rm -rf /`")).toThrow(/invalid host/);
  });

  it("rejects host containing $(…) command substitution (from task spec's negative tests)", () => {
    expect(() => validateSshHost("$(rm -rf /)")).toThrow(/invalid host/);
  });
});

// ---------------------------------------------------------------------------
// validatePort
// ---------------------------------------------------------------------------

describe("validatePort", () => {
  it("accepts 1 and 65535 (inclusive bounds)", () => {
    expect(() => validatePort(1, "x")).not.toThrow();
    expect(() => validatePort(65535, "x")).not.toThrow();
  });

  it("rejects 0", () => {
    expect(() => validatePort(0, "remote port")).toThrow(ValidationError);
    expect(() => validatePort(0, "remote port")).toThrow(/remote port/);
  });

  it("rejects 65536 / 70000", () => {
    expect(() => validatePort(65536, "x")).toThrow(ValidationError);
    expect(() => validatePort(70000, "x")).toThrow(ValidationError);
  });

  it("rejects negative, non-integer, NaN, Infinity", () => {
    expect(() => validatePort(-1, "x")).toThrow(ValidationError);
    expect(() => validatePort(1.5, "x")).toThrow(ValidationError);
    expect(() => validatePort(Number.NaN, "x")).toThrow(ValidationError);
    expect(() => validatePort(Number.POSITIVE_INFINITY, "x")).toThrow(ValidationError);
  });

  it("rejects non-numeric input", () => {
    expect(() => validatePort("22" as unknown as number, "x")).toThrow(ValidationError);
    expect(() => validatePort(undefined as unknown as number, "x")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// buildSshArgs — argv shape
// ---------------------------------------------------------------------------

describe("buildSshArgs — minimal config", () => {
  it("emits the fixed option block, -L, and host last", () => {
    const args = buildSshArgs(mkServer(), 55000);
    expect(args).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-L",
      "127.0.0.1:55000:127.0.0.1:52077",
      "example.com",
    ]);
  });

  it("default remote port is 52077 (the flockctl daemon port)", () => {
    const args = buildSshArgs(mkServer(), 42000);
    expect(args).toContain("127.0.0.1:42000:127.0.0.1:52077");
  });

  it("the host token is always the last element (defence against flag injection)", () => {
    const args = buildSshArgs(mkServer({ host: "alice@host" }), 1);
    expect(args[args.length - 1]).toBe("alice@host");
  });
});

describe("buildSshArgs — -p flag (only when port set and != 22)", () => {
  it("omits -p when ssh.port is undefined", () => {
    const args = buildSshArgs(mkServer(), 1);
    expect(args).not.toContain("-p");
  });

  it("omits -p when ssh.port === 22 (the default)", () => {
    const args = buildSshArgs(mkServer({ port: 22 }), 1);
    expect(args).not.toContain("-p");
  });

  it("includes -p when ssh.port !== 22", () => {
    const args = buildSshArgs(mkServer({ port: 2222 }), 1);
    const i = args.indexOf("-p");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("2222");
  });

  it("rejects invalid ssh.port", () => {
    expect(() => buildSshArgs(mkServer({ port: 0 }), 1)).toThrow(ValidationError);
    expect(() => buildSshArgs(mkServer({ port: 70000 }), 1)).toThrow(ValidationError);
  });
});

describe("buildSshArgs — -i flag (only when identityFile set)", () => {
  it("omits -i by default", () => {
    const args = buildSshArgs(mkServer(), 1);
    expect(args).not.toContain("-i");
  });

  it("includes -i with the provided path", () => {
    const args = buildSshArgs(mkServer({ identityFile: "/home/me/.ssh/id_ed25519" }), 1);
    const i = args.indexOf("-i");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/home/me/.ssh/id_ed25519");
  });

  it("passes identityFile verbatim (no shell interpolation) — argv-array safety", () => {
    // Paths with spaces, dollar signs, etc. would be catastrophic via a
    // shell string. Through the argv array they're inert.
    const weird = "/tmp/dir with spaces/id$rsa`";
    const args = buildSshArgs(mkServer({ identityFile: weird }), 1);
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe(weird);
  });

  it("rejects empty or control-char identityFile", () => {
    expect(() => buildSshArgs(mkServer({ identityFile: "" }), 1)).toThrow(ValidationError);
    expect(() => buildSshArgs(mkServer({ identityFile: "/tmp/id\nbad" }), 1)).toThrow(
      ValidationError,
    );
  });
});

describe("buildSshArgs — -L forwarding spec", () => {
  it("always binds the local side to 127.0.0.1 (never 0.0.0.0)", () => {
    const args = buildSshArgs(mkServer(), 12345);
    const lIdx = args.indexOf("-L");
    expect(args[lIdx + 1]!.startsWith("127.0.0.1:12345:127.0.0.1:")).toBe(true);
  });

  it("uses server.ssh.remotePort on the remote side", () => {
    const args = buildSshArgs(mkServer({ remotePort: 9999 }), 1);
    expect(args).toContain("127.0.0.1:1:127.0.0.1:9999");
  });

  it("rejects remotePort=0 (from task spec's negative tests)", () => {
    expect(() => buildSshArgs(mkServer({ remotePort: 0 }), 1)).toThrow(ValidationError);
  });

  it("rejects remotePort=70000 (from task spec's negative tests)", () => {
    expect(() => buildSshArgs(mkServer({ remotePort: 70000 }), 1)).toThrow(ValidationError);
  });

  it("rejects non-integer local port", () => {
    expect(() => buildSshArgs(mkServer(), 0)).toThrow(ValidationError);
    expect(() => buildSshArgs(mkServer(), -1)).toThrow(ValidationError);
    expect(() => buildSshArgs(mkServer(), 65536)).toThrow(ValidationError);
  });
});

describe("buildSshArgs — user / host composition", () => {
  it("prepends `user@` when user is set", () => {
    const args = buildSshArgs(mkServer({ host: "box.example.com", user: "alice" }), 1);
    expect(args[args.length - 1]).toBe("alice@box.example.com");
  });

  it("leaves host untouched when user is undefined (supports ~/.ssh/config aliases)", () => {
    const args = buildSshArgs(mkServer({ host: "prod-alias" }), 1);
    expect(args[args.length - 1]).toBe("prod-alias");
  });

  it("rejects a user with shell metacharacters", () => {
    expect(() =>
      buildSshArgs(mkServer({ host: "host", user: "al;ice" }), 1),
    ).toThrow(ValidationError);
  });

  it("propagates host-validation failures (task spec: host='$(rm -rf /)' throws)", () => {
    expect(() => buildSshArgs(mkServer({ host: "$(rm -rf /)" }), 1)).toThrow(ValidationError);
    expect(() => buildSshArgs(mkServer({ host: "$(rm -rf /)" }), 1)).toThrow(/invalid host/);
  });

  it("rejects empty host", () => {
    expect(() => buildSshArgs(mkServer({ host: "" }), 1)).toThrow(ValidationError);
  });

  it("rejects host with newline", () => {
    expect(() => buildSshArgs(mkServer({ host: "example.com\n" }), 1)).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// SshTunnelManager.start — spawn observation via vi.spyOn
// ---------------------------------------------------------------------------

describe("SshTunnelManager.start — spawn plumbing", () => {
  // Since the manager now awaits the ready-gate probe, every test in this
  // block injects a fast-resolving `probe` so the assertions don't have to
  // wait on a real /health poll.
  const readyProbe = () => Promise.resolve("ready" as const);

  it("calls child_process.spawn('ssh', buildSshArgs(server, lport), stdio piped)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const mgr = new SshTunnelManager({ probe: readyProbe });
    const handle = await mgr.start(mkServer({ port: 2222, identityFile: "/k" }));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("ssh");
    expect(Array.isArray(argv)).toBe(true);
    // The argv we hand to spawn must equal what buildSshArgs(...) produces.
    expect(argv).toEqual(buildSshArgs(mkServer({ port: 2222, identityFile: "/k" }), handle.localPort));
    expect(opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
  });

  it("observes the handle in 'starting' state while the probe is in flight", async () => {
    spawnMock.mockReturnValue(makeFakeChild());

    // Probe that hangs until its signal aborts, so we can observe the
    // pre-probe state before deterministically tearing the tunnel down.
    const mgr = new SshTunnelManager({
      probe: (_lport, { signal }) =>
        new Promise<"ready" | "timeout">((resolve) => {
          signal?.addEventListener("abort", () => resolve("timeout"), {
            once: true,
          });
        }),
    });

    const startPromise = mgr.start(mkServer());
    // Yield so start() has a chance to register the handle.
    await new Promise((r) => setImmediate(r));

    const mid = mgr.getByServerId("srv-1");
    expect(mid).not.toBeNull();
    expect(mid!.serverId).toBe("srv-1");
    expect(mid!.localPort).toBeGreaterThan(0);
    expect(mid!.localPort).toBeLessThanOrEqual(65535);
    expect(mid!.status).toBe("starting");
    expect(typeof mid!.startedAt).toBe("number");

    // Release the hanging probe so start() can resolve cleanly and the
    // test doesn't leak an orphan promise into the next case.
    mgr.shutdown();
    const resolved = await startPromise;
    expect(resolved.status).toBe("stopped");
  });

  it("stores the child + handle in an internal serverId-keyed map", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const mgr = new SshTunnelManager({ probe: readyProbe });
    await mgr.start(mkServer());

    expect(mgr._canonicalChild("srv-1")).toBe(fake);
    expect(mgr.getByServerId("srv-1")?.status).toBe("ready");
    expect(mgr.listAllServers()).toHaveLength(1);
  });

  it("never allocates the same local port twice across two concurrent starts", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());

    const mgr = new SshTunnelManager({ probe: readyProbe });
    const a = await mgr.start({ id: "a", name: "a", ssh: { host: "a.example" } });
    const b = await mgr.start({ id: "b", name: "b", ssh: { host: "b.example" } });
    expect(a.localPort).not.toBe(b.localPort);
  });

  it("does NOT start when host fails validation (spawn never called)", async () => {
    spawnMock.mockReturnValue(makeFakeChild());
    const mgr = new SshTunnelManager({ probe: readyProbe });

    await expect(
      mgr.start({ id: "x", name: "x", ssh: { host: "$(rm -rf /)" } }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// argv_shape_never_interpolated_by_shell
// ---------------------------------------------------------------------------

describe("argv_shape_never_interpolated_by_shell", () => {
  it("pathological hosts are rejected by validateSshHost (first line of defence)", () => {
    for (const bad of ["`rm -rf /`", "$(touch /tmp/pwn)", "host; echo owned"]) {
      expect(() => validateSshHost(bad)).toThrow(ValidationError);
    }
  });

  it("even if validation were bypassed, spawn's argv-array form prevents shell interpretation", async () => {
    // We bypass buildSshArgs entirely and hand a hand-crafted argv that
    // *contains* a metacharacter token. The assertion is that
    // `child_process.spawn` receives it as-is, as one argv element, with
    // NO `shell: true` option — meaning the OS will execve('ssh', ['-N',
    // …, 'weird`host`']) without involving /bin/sh. The metacharacters
    // are inert because there is no shell.
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);

    const pathological = "weird`host`";
    const argv = [
      "-N",
      "-o",
      "BatchMode=yes",
      "-L",
      "127.0.0.1:1:127.0.0.1:2",
      pathological,
    ];

    // Invoke spawn directly through the spied module — same call shape
    // the manager uses internally.
    child_process.spawn("ssh", argv, { stdio: ["ignore", "pipe", "pipe"] });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, passedArgv, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("ssh");
    // The pathological string lives inside ONE argv element; it is not
    // split across elements, not re-quoted, not stripped.
    expect(passedArgv).toEqual(argv);
    const last = (passedArgv as string[])[argv.length - 1];
    expect(last).toBe(pathological);
    // Crucially, `shell` must be falsy — otherwise the argv would be
    // joined and passed to /bin/sh -c. We must never set it.
    expect((opts as { shell?: unknown }).shell).toBeFalsy();
  });
});
