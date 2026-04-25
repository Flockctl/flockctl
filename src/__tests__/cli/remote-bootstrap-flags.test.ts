/**
 * `flockctl remote-bootstrap` — flag parsing and input validation.
 *
 * This is the plumbing-only layer of the remote-bootstrap command. Daemon
 * lifecycle (task 01) and token minting (task 02) land in follow-up commits;
 * here we only assert that:
 *
 *   - valid inputs return 0 and write nothing,
 *   - bad labels (control chars) return 1 with a single stderr line,
 *   - out-of-range / non-integer ports return 1 with a single stderr line,
 *   - the `--help` output lists every public flag (discoverability check),
 *   - the subcommand is registered on the top-level program.
 *
 * We drive `runRemoteBootstrap` directly with a raw argv array — that's the
 * public contract — and capture process.stdout/stderr via vitest spies so we
 * can assert one-liner error messages without matching stack traces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";

import {
  runRemoteBootstrap as realRunRemoteBootstrap,
  registerRemoteBootstrapCommand,
  type RunRemoteBootstrapDeps,
} from "../../cli-commands/remote-bootstrap.js";

/**
 * The real `runRemoteBootstrap` now spawns a daemon and writes to
 * `~/.flockctlrc`. These tests are still flag-parsing / validation only, so
 * we wrap the function with no-op stubs for both side-effectful dependencies.
 * Individual tests can still pass their own deps via the overload by calling
 * the exported function directly.
 */
const STUB_DEPS: RunRemoteBootstrapDeps = {
  ensureDaemon: async () => {},
  ensureToken: (label) => `stub-token-for-${label}-xxxxxxxxxxxxxxxxxxxx`,
};

const runRemoteBootstrap = (argv: string[]) =>
  realRunRemoteBootstrap(argv, STUB_DEPS);

/* -------------------------------------------------------------------------- */
/* stdout / stderr capture                                                    */
/* -------------------------------------------------------------------------- */

interface Captured {
  stdout: string;
  stderr: string;
}

let captured: Captured;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured = { stdout: "", stderr: "" };
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write);
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as unknown as typeof process.stderr.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — happy path", () => {
  it("returns 0 and writes nothing for default args", async () => {
    const code = await runRemoteBootstrap([]);
    expect(code).toBe(0);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toBe("");
  });

  it("accepts --print-token --label foo --port 52100", async () => {
    // With daemon + token wiring in place, --print-token now writes the
    // token to stdout. We only care here that the flags parse cleanly and
    // the command succeeds — the stdout-contract suite
    // (remote-bootstrap-stdout.test.ts) asserts the exact byte output.
    const code = await runRemoteBootstrap([
      "--print-token",
      "--label",
      "foo",
      "--port",
      "52100",
    ]);
    expect(code).toBe(0);
    expect(captured.stderr).toBe("");
  });

  it("accepts boundary ports 1 and 65535", async () => {
    const lo = await runRemoteBootstrap(["--port", "1"]);
    expect(lo).toBe(0);

    // reset capture between calls to avoid cross-assertion noise
    captured.stderr = "";
    const hi = await runRemoteBootstrap(["--port", "65535"]);
    expect(hi).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Port validation                                                            */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — port validation", () => {
  it("rejects port 0", async () => {
    const code = await runRemoteBootstrap(["--port", "0"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid port: 0\n");
    expect(captured.stdout).toBe("");
  });

  it("rejects port 65536", async () => {
    const code = await runRemoteBootstrap(["--port", "65536"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid port: 65536\n");
  });

  it("rejects a negative port", async () => {
    const code = await runRemoteBootstrap(["--port", "-1"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid port: -1\n");
  });

  it("rejects a non-numeric port", async () => {
    const code = await runRemoteBootstrap(["--port", "abc"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid port: abc\n");
  });

  it("rejects a fractional port", async () => {
    const code = await runRemoteBootstrap(["--port", "52077.5"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid port: 52077.5\n");
  });

  it("writes no stack trace on port error", async () => {
    await runRemoteBootstrap(["--port", "999999"]);
    // A stack trace would contain "at " frames from Node's Error.stack.
    expect(captured.stderr).not.toMatch(/\n\s*at /);
    // Exactly one line of output.
    expect(captured.stderr.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Label validation                                                           */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — label validation", () => {
  it("rejects a label with an embedded newline", async () => {
    const code = await runRemoteBootstrap(["--label", "bad\nname"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid label\n");
  });

  it("rejects a label with a tab character", async () => {
    const code = await runRemoteBootstrap(["--label", "bad\tname"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid label\n");
  });

  it("rejects a label with a carriage return", async () => {
    const code = await runRemoteBootstrap(["--label", "bad\rname"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid label\n");
  });

  it("rejects a label containing the DEL character (0x7F)", async () => {
    const code = await runRemoteBootstrap(["--label", `bad${String.fromCharCode(0x7f)}name`]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid label\n");
  });

  it("rejects a label containing a NUL byte", async () => {
    const code = await runRemoteBootstrap(["--label", "bad\x00name"]);
    expect(code).toBe(1);
    expect(captured.stderr).toBe("invalid label\n");
  });

  it("accepts labels with spaces, hyphens, dots, and unicode", async () => {
    const code = await runRemoteBootstrap([
      "--label",
      "my laptop-1.home • café",
    ]);
    expect(code).toBe(0);
    expect(captured.stderr).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* --help discoverability                                                     */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — --help", () => {
  it("prints flag names on --help and returns 0", async () => {
    const code = await runRemoteBootstrap(["--help"]);
    expect(code).toBe(0);
    expect(captured.stdout).toContain("--print-token");
    expect(captured.stdout).toContain("--label");
    expect(captured.stdout).toContain("--port");
  });
});

/* -------------------------------------------------------------------------- */
/* Unknown-flag rejection                                                     */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — unknown flags", () => {
  it("returns non-zero on an unknown option", async () => {
    const code = await runRemoteBootstrap(["--nope"]);
    expect(code).not.toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* registerRemoteBootstrapCommand — wiring into the top-level program         */
/* -------------------------------------------------------------------------- */

describe("registerRemoteBootstrapCommand", () => {
  it("registers a `remote-bootstrap` subcommand on the program", () => {
    const program = new Command();
    registerRemoteBootstrapCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("remote-bootstrap");
  });

  it("declares --print-token, --label, --port on the subcommand", () => {
    const program = new Command();
    registerRemoteBootstrapCommand(program);
    const sub = program.commands.find((c) => c.name() === "remote-bootstrap");
    expect(sub).toBeDefined();
    const flags = sub!.options.map((o) => o.long);
    expect(flags).toContain("--print-token");
    expect(flags).toContain("--label");
    expect(flags).toContain("--port");
  });
});
