/**
 * Structural + behavioural tests for `flockctl version` and
 * `flockctl completion`. We avoid spinning up a real daemon — the version
 * command's --remote path is exercised by mocking `DaemonClient`. The
 * completion command is pure stdout, so we capture and assert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerVersionCommand } from "../../cli-commands/version.js";
import { registerCompletionCommand } from "../../cli-commands/completion.js";

function newProgram(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return p;
}

function findSub(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

describe("registerVersionCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("registers a `version` command with --json and --remote flags", () => {
    const program = newProgram();
    registerVersionCommand(program);
    const cmd = findSub(program, "version")!;
    expect(cmd).toBeDefined();
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--json");
    expect(flags).toContain("--remote");
  });

  it("prints human-readable version block by default", async () => {
    const program = newProgram();
    registerVersionCommand(program);
    await program.parseAsync(["node", "flockctl", "version"]);
    const joined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(joined).toMatch(/^flockctl /);
    expect(joined).toMatch(/node:/);
    expect(joined).toMatch(/platform:/);
    expect(joined).toMatch(/install:/);
  });

  it("--json emits a single parseable JSON document", async () => {
    const program = newProgram();
    registerVersionCommand(program);
    await program.parseAsync(["node", "flockctl", "version", "--json"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = String(logSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      version: expect.any(String),
      node: expect.stringMatching(/^v/),
      platform: expect.any(String),
      arch: expect.any(String),
      install: expect.objectContaining({ mode: expect.any(String) }),
    });
    expect(parsed.daemon).toBeUndefined();
  });

  it("--remote includes a daemon field — populated with error when daemon is down", async () => {
    // We force the daemon address to a port nothing listens on so the
    // remote fetch fails fast and lands in the catch path.
    const oldPort = process.env.FLOCKCTL_PORT;
    process.env.FLOCKCTL_PORT = "1"; // privileged port — connection refused
    try {
      const program = newProgram();
      registerVersionCommand(program);
      await program.parseAsync(["node", "flockctl", "version", "--json", "--remote"]);
      const out = String(logSpy.mock.calls[0]![0]);
      const parsed = JSON.parse(out);
      expect(parsed.daemon).toBeDefined();
      expect(parsed.daemon).toHaveProperty("error");
    } finally {
      if (oldPort === undefined) delete process.env.FLOCKCTL_PORT;
      else process.env.FLOCKCTL_PORT = oldPort;
    }
  });
});

describe("registerCompletionCommand", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function setupProgram(): Command {
    const program = newProgram();
    // Add a couple of fake siblings so we can verify the completion script
    // includes them but not "completion" itself.
    program.command("alpha").action(() => {});
    program.command("beta").action(() => {});
    registerCompletionCommand(program);
    return program;
  }

  it("registers a `completion <shell>` command", () => {
    const program = newProgram();
    registerCompletionCommand(program);
    expect(findSub(program, "completion")).toBeDefined();
  });

  it("emits a bash script that complete-registers `flockctl` and lists siblings", async () => {
    const program = setupProgram();
    await program.parseAsync(["node", "flockctl", "completion", "bash"]);
    const script = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(script).toMatch(/^# flockctl bash completion/m);
    expect(script).toContain("complete -F _flockctl_completion flockctl");
    // The subcommand list lives between the quotes after `-W`. We assert
    // that list contains the siblings but not the `completion` command itself.
    const list = /-W "([^"]+)"/.exec(script)?.[1] ?? "";
    expect(list.split(/\s+/).sort()).toEqual(["alpha", "beta"]);
  });

  it("emits a zsh script that uses compdef", async () => {
    const program = setupProgram();
    await program.parseAsync(["node", "flockctl", "completion", "zsh"]);
    const script = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(script).toContain("compdef _flockctl flockctl");
    expect(script).toMatch(/'alpha'/);
    expect(script).toMatch(/'beta'/);
  });

  it("emits a fish script with one `complete` line per subcommand", async () => {
    const program = setupProgram();
    await program.parseAsync(["node", "flockctl", "completion", "fish"]);
    const script = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(script).toMatch(/complete -c flockctl .* -a "alpha"/);
    expect(script).toMatch(/complete -c flockctl .* -a "beta"/);
  });

  it("rejects unknown shells and exits 1", async () => {
    const program = setupProgram();
    await expect(
      program.parseAsync(["node", "flockctl", "completion", "powershell"]),
    ).rejects.toThrow("exit");
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(err).toMatch(/unsupported shell/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
