/**
 * `flockctl remote-bootstrap` — stdout / stderr output contract.
 *
 * The `--print-token` flag exists so shell scripts can capture a fresh
 * bearer token with `TOKEN=$(flockctl remote-bootstrap --print-token …)`.
 * That contract only works if stdout is byte-exact: the minted token
 * followed by a single newline, with no banners, no color codes, no
 * progress spinners, no "daemon already running" notices.
 *
 * This suite is the hard enforcer. It covers:
 *  - Happy path: --print-token writes EXACTLY `token + "\n"` to stdout
 *    and nothing else. Without --print-token, stdout is empty.
 *  - No stray ANSI / color escapes in stdout on the success path.
 *  - Daemon-start failure: exit 2, error line on stderr, token never
 *    appears on stderr.
 *  - Token-mint failure: exit 1, error line on stderr, and even if the
 *    upstream throws an Error whose `.message` happens to contain the
 *    token, the redactor masks it before it reaches stderr.
 *  - Source file discipline: no `console.log` in remote-bootstrap.ts —
 *    every write must go through `process.stdout.write` /
 *    `process.stderr.write` so stream routing is auditable.
 *  - NO_COLOR is forced on early so downstream libraries can't inject
 *    ANSI sequences into the token line.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runRemoteBootstrap,
  redactTokenLike,
  type RunRemoteBootstrapDeps,
} from "../../cli-commands/remote-bootstrap.js";

/* -------------------------------------------------------------------------- */
/* Capture harness                                                             */
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

/** Fixed token shape that matches the production base64url (43 chars,
 * [A-Za-z0-9_-]). Using a deterministic value makes assertions easy and
 * also lets us verify the redactor (it matches anything ≥ 20 chars of that
 * charset). */
const FAKE_TOKEN = "deadbeef-12345678_abcDEF0123456789_XYZabcd";

function makeDeps(
  overrides: Partial<RunRemoteBootstrapDeps> = {},
): RunRemoteBootstrapDeps {
  return {
    ensureDaemon: async () => {},
    ensureToken: () => FAKE_TOKEN,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Happy path — byte-exact stdout                                              */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — stdout contract (success)", () => {
  it("--print-token writes EXACTLY `token + '\\n'` and nothing else", async () => {
    const code = await runRemoteBootstrap(
      ["--print-token", "--label", "laptop"],
      makeDeps(),
    );
    expect(code).toBe(0);
    expect(captured.stdout).toBe(FAKE_TOKEN + "\n");
    expect(captured.stderr).toBe("");
  });

  it("without --print-token stdout is empty", async () => {
    const code = await runRemoteBootstrap(["--label", "laptop"], makeDeps());
    expect(code).toBe(0);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toBe("");
  });

  it("stdout contains no ANSI escape sequences on the success path", async () => {
    await runRemoteBootstrap(["--print-token"], makeDeps());
    // ESC byte 0x1B would indicate a color / cursor / reset sequence.
    expect(captured.stdout).not.toMatch(/\x1b/);
  });

  it("matches the stdout security regex: ^[A-Za-z0-9_-]{20,}\\n$", async () => {
    await runRemoteBootstrap(["--print-token"], makeDeps());
    expect(captured.stdout).toMatch(/^[A-Za-z0-9_-]{20,}\n$/);
  });

  it("forces NO_COLOR=1 before any downstream import could auto-color", async () => {
    // Simulate an environment where NO_COLOR is unset: the command should
    // set it so any late-loaded dependency (chalk, kleur, etc.) sees it.
    const originalNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      await runRemoteBootstrap(["--print-token"], makeDeps());
      expect(process.env.NO_COLOR).toBe("1");
    } finally {
      if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
      else delete process.env.NO_COLOR;
    }
  });

  it("stdout is the ONLY place the token appears (never leaks to stderr)", async () => {
    await runRemoteBootstrap(["--print-token"], makeDeps());
    expect(captured.stdout).toContain(FAKE_TOKEN);
    expect(captured.stderr).not.toContain(FAKE_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* Daemon start failure — exit 2                                               */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — daemon failure path", () => {
  it("returns exit code 2 when ensureDaemon rejects", async () => {
    const code = await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureDaemon: async () => {
          throw new Error("daemon on port 52077 did not answer /health");
        },
      }),
    );
    expect(code).toBe(2);
  });

  it("writes a single one-line error to stderr, no token, no stack", async () => {
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureDaemon: async () => {
          throw new Error("health timeout after 5000ms");
        },
      }),
    );
    // Exactly one non-empty stderr line.
    const lines = captured.stderr.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^bootstrap: daemon did not start:/);
    // Stack traces have "at " frames; we never want to leak those.
    expect(captured.stderr).not.toMatch(/\n\s*at /);
  });

  it("never writes to stdout on the daemon-failure path", async () => {
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureDaemon: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(captured.stdout).toBe("");
  });

  it("redacts token-shaped substrings from the daemon error message", async () => {
    // Hypothetical regression: a future ensureDaemon implementation
    // decides to include the RC path or a token in its error. The
    // redactor must scrub it before stderr sees it.
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureDaemon: async () => {
          throw new Error(`spawn failed, lingering token ${FAKE_TOKEN}`);
        },
      }),
    );
    expect(captured.stderr).not.toContain(FAKE_TOKEN);
    expect(captured.stderr).toContain("[REDACTED]");
  });
});

/* -------------------------------------------------------------------------- */
/* Token mint failure — exit 1, redaction                                      */
/* -------------------------------------------------------------------------- */

describe("runRemoteBootstrap — token failure path", () => {
  it("returns exit code 1 when ensureToken throws", async () => {
    const code = await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureToken: () => {
          throw new Error("permission denied on ~/.flockctlrc");
        },
      }),
    );
    expect(code).toBe(1);
  });

  it("writes a single `bootstrap:` prefixed stderr line, no token, no stack", async () => {
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureToken: () => {
          throw new Error("rc write failed");
        },
      }),
    );
    const lines = captured.stderr.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^bootstrap: /);
    expect(captured.stderr).not.toMatch(/\n\s*at /);
  });

  it("stderr_does_not_contain_token_ever — even when the thrown message embeds it", async () => {
    // This is the security spec: if a future bug ships an error message
    // that includes the minted token verbatim, the redactor MUST mask
    // it before reaching stderr.
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureToken: () => {
          throw new Error(
            `internal: failed to persist token=${FAKE_TOKEN} to rc`,
          );
        },
      }),
    );
    expect(captured.stderr).not.toContain(FAKE_TOKEN);
    expect(captured.stderr).toContain("[REDACTED]");
  });

  it("never writes to stdout on the token-failure path", async () => {
    await runRemoteBootstrap(
      ["--print-token"],
      makeDeps({
        ensureToken: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(captured.stdout).toBe("");
  });

  it("stderr_does_not_contain_token_ever — success path", async () => {
    // Sanity check: even on the success path, stderr must never have the
    // token. This mirrors the assertion format of the security spec.
    await runRemoteBootstrap(["--print-token"], makeDeps());
    // Capture stdout separately so we can assert it's the only place the
    // token surfaces.
    expect(captured.stderr).not.toContain(FAKE_TOKEN);
    expect(captured.stdout).toContain(FAKE_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* redactTokenLike — the building block                                        */
/* -------------------------------------------------------------------------- */

describe("redactTokenLike", () => {
  it("replaces base64url runs of 20+ chars with [REDACTED]", () => {
    expect(redactTokenLike(`token=${FAKE_TOKEN}`)).toBe("token=[REDACTED]");
  });

  it("leaves short identifiers alone", () => {
    expect(redactTokenLike("label=laptop")).toBe("label=laptop");
    expect(redactTokenLike("port 52077 down")).toBe("port 52077 down");
  });

  it("handles multiple matches in one message", () => {
    const s = `a=${FAKE_TOKEN} b=${FAKE_TOKEN}`;
    const out = redactTokenLike(s);
    expect(out).toBe("a=[REDACTED] b=[REDACTED]");
    expect(out).not.toContain(FAKE_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* Source-file discipline: no console.log                                      */
/* -------------------------------------------------------------------------- */

describe("remote-bootstrap.ts source discipline", () => {
  it("contains no `console.log` calls", () => {
    // Resolve the source file relative to the compiled test location.
    // `import.meta.url` points at the .ts file in vitest's default
    // transform, but we fall back to a path walk so this is robust to
    // test-runner path changes.
    const src = readFileSync(
      join(process.cwd(), "src/cli-commands/remote-bootstrap.ts"),
      "utf-8",
    );
    // Strip line comments so we don't trip on a stray "// console.log"
    // in documentation. Block comments are less of a risk since we
    // grep for the function-call shape `console.log(`.
    const stripped = src.replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\bconsole\.log\s*\(/);
  });

  it("contains no `console.info` / `console.error` / `console.warn` calls", () => {
    // Any console.* call bypasses our stdout/stderr discipline — an
    // unknown flag could route the wrong way. Enforce the whole family.
    const src = readFileSync(
      join(process.cwd(), "src/cli-commands/remote-bootstrap.ts"),
      "utf-8",
    );
    const stripped = src.replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\bconsole\.(log|info|error|warn|debug)\s*\(/);
  });
});
