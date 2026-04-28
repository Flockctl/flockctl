/**
 * Structural tests for batch 1 CLI commands: tasks, secrets, ai-keys, doctor.
 *
 * We mirror the project/workspace test pattern: register the command tree
 * onto a stub commander program, then assert that every advertised
 * subcommand and flag is wired. Action handlers themselves talk to the
 * daemon over HTTP — those code paths are exercised by the route tests
 * in `routes/*.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerTasksCommand } from "../../cli-commands/tasks.js";
import { registerSecretsCommand } from "../../cli-commands/secrets.js";
import { registerAiKeysCommand } from "../../cli-commands/ai-keys.js";
import { registerDoctorCommand } from "../../cli-commands/doctor.js";

function newProgram(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return p;
}

function findSub(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

function flagNames(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? o.short ?? "");
}

describe("registerTasksCommand", () => {
  it("registers `tasks` and all subcommands", () => {
    const program = newProgram();
    registerTasksCommand(program);
    const tasks = findSub(program, "tasks")!;
    expect(tasks).toBeDefined();
    for (const sub of [
      "list",
      "show",
      "create",
      "cancel",
      "rerun",
      "approve",
      "reject",
      "logs",
      "stats",
    ]) {
      expect(findSub(tasks, sub), `missing: tasks ${sub}`).toBeDefined();
    }
  });

  it("`tasks list` exposes filter flags", () => {
    const program = newProgram();
    registerTasksCommand(program);
    const list = findSub(findSub(program, "tasks")!, "list")!;
    const flags = flagNames(list);
    for (const f of [
      "--project",
      "--status",
      "--type",
      "--label",
      "--page",
      "--per-page",
      "--include-superseded",
      "--json",
    ]) {
      expect(flags, `tasks list missing ${f}`).toContain(f);
    }
  });

  it("`tasks create` exposes prompt + agent flags", () => {
    const program = newProgram();
    registerTasksCommand(program);
    const create = findSub(findSub(program, "tasks")!, "create")!;
    const flags = flagNames(create);
    for (const f of [
      "--project",
      "--prompt",
      "--prompt-file",
      "--agent",
      "--model",
      "--type",
      "--label",
      "--requires-approval",
      "--permission-mode",
      "--json",
    ]) {
      expect(flags, `tasks create missing ${f}`).toContain(f);
    }
  });

  it("`tasks logs` exposes follow / interval / verbose", () => {
    const program = newProgram();
    registerTasksCommand(program);
    const logs = findSub(findSub(program, "tasks")!, "logs")!;
    const flags = flagNames(logs);
    expect(flags).toContain("--follow");
    expect(flags).toContain("--interval-ms");
    expect(flags).toContain("--verbose");
  });
});

describe("registerSecretsCommand", () => {
  it("registers `secrets` with list/set/rm", () => {
    const program = newProgram();
    registerSecretsCommand(program);
    const cmd = findSub(program, "secrets")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "set", "rm"]) {
      expect(findSub(cmd, sub)).toBeDefined();
    }
  });

  it("every subcommand accepts --workspace / --project scope flags", () => {
    const program = newProgram();
    registerSecretsCommand(program);
    const cmd = findSub(program, "secrets")!;
    for (const sub of ["list", "set", "rm"]) {
      const flags = flagNames(findSub(cmd, sub)!);
      expect(flags, `${sub} missing --workspace`).toContain("--workspace");
      expect(flags, `${sub} missing --project`).toContain("--project");
    }
  });
});

describe("registerAiKeysCommand", () => {
  it("registers `ai-keys` with list / show / providers / status", () => {
    const program = newProgram();
    registerAiKeysCommand(program);
    const cmd = findSub(program, "ai-keys")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "show", "providers", "status"]) {
      expect(findSub(cmd, sub), `missing: ai-keys ${sub}`).toBeDefined();
    }
  });
});

describe("registerDoctorCommand", () => {
  it("registers `doctor` with --json", () => {
    const program = newProgram();
    registerDoctorCommand(program);
    const cmd = findSub(program, "doctor")!;
    expect(cmd).toBeDefined();
    expect(flagNames(cmd)).toContain("--json");
  });
});
