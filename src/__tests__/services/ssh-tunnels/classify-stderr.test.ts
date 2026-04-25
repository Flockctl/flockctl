import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  classifyStderr,
  stripAnsi,
  type TunnelErrorCode,
} from "../../../services/ssh-tunnels/classify-stderr.js";
import {
  buildSshArgv,
  SshTunnelManager,
} from "../../../services/ssh-tunnels/manager.js";

describe("classifyStderr — pattern table", () => {
  const cases: Array<[string, string, TunnelErrorCode]> = [
    [
      "REMOTE HOST IDENTIFICATION HAS CHANGED banner",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
        "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n",
      "host_key_mismatch",
    ],
    [
      "Host key verification failed",
      "Host key verification failed.\r\n",
      "host_key_mismatch",
    ],
    [
      "Permission denied (publickey) specifically",
      "user@example.com: Permission denied (publickey).\n",
      "auth_failed",
    ],
    [
      "generic Permission denied",
      "Permission denied, please try again.\n",
      "auth_failed",
    ],
    [
      "Connection refused",
      "ssh: connect to host example.com port 22: Connection refused\n",
      "connect_refused",
    ],
    [
      "Name or service not known",
      "ssh: Could not resolve hostname example.invalid: Name or service not known\n",
      "connect_refused",
    ],
    [
      "Could not resolve hostname (mac variant)",
      "ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known\n",
      "connect_refused",
    ],
    [
      "channel open failed — remote daemon down",
      "channel 3: open failed: connect failed: Connection refused\n",
      "remote_daemon_down",
    ],
    [
      "flockctl command not found on remote shell",
      "bash: flockctl: command not found\n",
      "remote_flockctl_missing",
    ],
    [
      "flockctl No such file or directory",
      "/usr/bin/env: 'flockctl': No such file or directory\n",
      "remote_flockctl_missing",
    ],
  ];

  for (const [name, stderr, expected] of cases) {
    it(`classifies: ${name} → ${expected}`, () => {
      const { errorCode } = classifyStderr(stderr, 1);
      expect(errorCode).toBe(expected);
    });
  }

  it("is case-insensitive", () => {
    expect(classifyStderr("permission denied (publickey).", 255).errorCode).toBe(
      "auth_failed",
    );
    expect(
      classifyStderr("CONNECTION REFUSED BY THE WEATHER", 255).errorCode,
    ).toBe("connect_refused");
  });
});

describe("classifyStderr — error_code_priority (THE key UX guarantee)", () => {
  it("host_key_mismatch wins over auth_failed when both present", () => {
    const both =
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n" +
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
      "Host key verification failed.\n" +
      "user@example.com: Permission denied (publickey).\n";
    expect(classifyStderr(both, 255).errorCode).toBe("host_key_mismatch");
  });

  it("Host key verification failed still beats a trailing Permission denied", () => {
    const stderr =
      "Host key verification failed.\n" +
      "user@example.com: Permission denied (publickey,password).\n";
    expect(classifyStderr(stderr, 255).errorCode).toBe("host_key_mismatch");
  });

  it("publickey-specific Permission denied matches auth_failed (not a fallthrough bug)", () => {
    expect(
      classifyStderr(
        "user@example.com: Permission denied (publickey).",
        255,
      ).errorCode,
    ).toBe("auth_failed");
  });
});

describe("classifyStderr — exit code 127 fallback", () => {
  it("returns remote_flockctl_missing on exit 127 when nothing matched", () => {
    // Some shells (busybox, fish) print an unusual error string we
    // don't match; exit 127 from the remote shell is still the
    // canonical "exec failed" signal.
    const { errorCode, rawStderr } = classifyStderr(
      "fish: Unknown command: flockctl\n",
      127,
    );
    expect(errorCode).toBe("remote_flockctl_missing");
    expect(rawStderr).toContain("Unknown command");
  });

  it("pattern match still wins over the 127 fallback", () => {
    expect(
      classifyStderr("bash: flockctl: command not found\n", 127).errorCode,
    ).toBe("remote_flockctl_missing");
  });
});

describe("classifyStderr — unknown with preserved stderr", () => {
  it("returns unknown and preserves the raw tail on unmatched non-zero exit", () => {
    const stderr = "kex_exchange_identification: Connection closed by remote host\n";
    const { errorCode, rawStderr } = classifyStderr(stderr, 255);
    expect(errorCode).toBe("unknown");
    expect(rawStderr).toBe(stderr);
  });

  it("truncates to ~2KB, keeping the tail (the useful end of the log)", () => {
    const head = "x".repeat(5000);
    const tail = "FINAL DIAGNOSTIC LINE\n";
    const { rawStderr } = classifyStderr(head + tail, 255);
    expect(rawStderr.length).toBeLessThanOrEqual(2048);
    expect(rawStderr.endsWith(tail)).toBe(true);
  });

  it("returns unknown for exit 0 with empty stderr (tunnel closed cleanly, no error)", () => {
    // The canonical TunnelErrorCode union (./types.ts) doesn't have an
    // `ok` member — an empty / clean shutdown still lands in `unknown`
    // with an empty rawStderr, which the UI treats as a non-error.
    const { errorCode, rawStderr } = classifyStderr("", 0);
    expect(errorCode).toBe("unknown");
    expect(rawStderr).toBe("");
  });
});

describe("classifyStderr — ANSI stripping", () => {
  it("strips colour escapes before matching", () => {
    // Real ssh doesn't colorize, but wrappers and terminal multiplexers
    // sometimes do. The ANSI must never defeat the regex.
    const colored = "\x1b[31mHost key verification failed.\x1b[0m\n";
    expect(classifyStderr(colored, 255).errorCode).toBe("host_key_mismatch");
  });

  it("stripAnsi removes CSI SGR sequences", () => {
    expect(stripAnsi("\x1b[1;31mred\x1b[0m plain")).toBe("red plain");
  });

  it("strips ANSI from rawStderr too", () => {
    const { rawStderr } = classifyStderr(
      "\x1b[31msome failure\x1b[0m\n",
      255,
    );
    expect(rawStderr).toBe("some failure\n");
  });
});

describe("buildSshArgv — BatchMode invariant", () => {
  it("always sets BatchMode=yes (the reason the password_prompt test holds)", () => {
    const argv = buildSshArgv({
      host: "example.com",
      localPort: 52077,
      remoteHost: "localhost",
      remotePort: 52077,
    });
    const batchIdx = argv.indexOf("BatchMode=yes");
    expect(batchIdx).toBeGreaterThan(0);
    expect(argv[batchIdx - 1]).toBe("-o");
  });

  it("appends caller-supplied -o options alongside BatchMode", () => {
    const argv = buildSshArgv({
      host: "example.com",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      extraOptions: ["StrictHostKeyChecking=accept-new"],
    });
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
  });
});

/**
 * Simulate an ssh child that writes a password prompt to stdout.
 * The assertion is layered:
 *   (a) BatchMode=yes is in argv, so in the real world ssh NEVER
 *       reads from stdin or writes `password:` to the user.
 *   (b) When a stub child misbehaves by emitting `password: ` anyway,
 *       the classifier still picks up the stderr ssh-in-BatchMode would
 *       actually write ("Permission denied (publickey)") and returns
 *       `auth_failed`. We do NOT tie classification to stdout at all.
 */
describe("SshTunnelManager — password_prompt_never_appears", () => {
  function makeFakeChild(): {
    proc: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    emitExit: (code: number) => void;
  } {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    emitter.kill = () => {};
    return {
      proc: emitter,
      emitExit: (code: number) => emitter.emit("exit", code),
    };
  }

  it("BatchMode argv includes -o BatchMode=yes", () => {
    const argv = buildSshArgv({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
    });
    const i = argv.indexOf("BatchMode=yes");
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe("-o");
  });

  it("a misbehaving child writing `password:` to stdout does NOT flip the classifier; stderr in BatchMode still yields auth_failed", async () => {
    const { proc, emitExit } = makeFakeChild();
    const mgr = new SshTunnelManager();
    const handle = mgr.open({
      host: "example.com",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => proc) as unknown as typeof import("node:child_process").spawn,
    });

    // Even though the stub emits a password prompt on stdout, we must
    // not classify from stdout. Classification is strictly stderr-based.
    proc.stdout.write("password: ");

    // What ssh in BatchMode=yes actually writes on auth failure:
    proc.stderr.write("user@example.com: Permission denied (publickey).\n");

    const exited = new Promise<void>((resolve) =>
      handle.events.once("exit", () => resolve()),
    );
    emitExit(255);
    await exited;

    expect(handle.errorCode).toBe("auth_failed");
    expect(handle.exitCode).toBe(255);
    expect(handle.rawStderr).toContain("Permission denied");
    // stdout content must not leak into rawStderr.
    expect(handle.rawStderr).not.toContain("password:");
  });

  it("stores errorCode + rawStderr on the handle at exit (host_key_mismatch case)", async () => {
    const { proc, emitExit } = makeFakeChild();
    const mgr = new SshTunnelManager();
    const handle = mgr.open({
      host: "example.com",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => proc) as unknown as typeof import("node:child_process").spawn,
    });

    proc.stderr.write(
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n",
    );
    proc.stderr.write("Host key verification failed.\n");
    proc.stderr.write("user@example.com: Permission denied (publickey).\n");

    const exited = new Promise<void>((resolve) =>
      handle.events.once("exit", () => resolve()),
    );
    emitExit(255);
    await exited;

    expect(handle.errorCode).toBe("host_key_mismatch");
    expect(handle.rawStderr).toContain("REMOTE HOST IDENTIFICATION HAS CHANGED");
  });

  it("reclassifies on stderr-read before exit so the UI can show errors while the tunnel is still dying", async () => {
    const { proc, emitExit } = makeFakeChild();
    const mgr = new SshTunnelManager();
    const handle = mgr.open({
      host: "example.com",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => proc) as unknown as typeof import("node:child_process").spawn,
    });

    // Initial state is "unknown" — the canonical TunnelErrorCode union
    // (./types.ts) has no `ok` member; absence-of-error is represented
    // as `unknown` with empty rawStderr.
    expect(handle.errorCode).toBe("unknown");
    expect(handle.rawStderr).toBe("");

    proc.stderr.write("Host key verification failed.\n");
    // Give the 'data' event a tick to fire.
    await new Promise((r) => setImmediate(r));

    expect(handle.errorCode).toBe("host_key_mismatch");
    expect(handle.exited).toBe(false);

    const exited = new Promise<void>((resolve) =>
      handle.events.once("exit", () => resolve()),
    );
    emitExit(255);
    await exited;
    expect(handle.errorCode).toBe("host_key_mismatch");
  });
});
