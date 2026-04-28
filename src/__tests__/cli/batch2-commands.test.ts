/**
 * Structural tests for batch 2 CLI commands: mcp, skills, templates, schedules.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerMcpCommand } from "../../cli-commands/mcp.js";
import { registerSkillsCommand } from "../../cli-commands/skills.js";
import { registerTemplatesCommand } from "../../cli-commands/templates.js";
import { registerSchedulesCommand } from "../../cli-commands/schedules.js";

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

describe("registerMcpCommand", () => {
  it("registers mcp with list/resolved/add/rm", () => {
    const program = newProgram();
    registerMcpCommand(program);
    const cmd = findSub(program, "mcp")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "resolved", "add", "rm"]) {
      expect(findSub(cmd, sub), `missing: mcp ${sub}`).toBeDefined();
    }
  });

  it("mcp add takes --config-file as required", () => {
    const program = newProgram();
    registerMcpCommand(program);
    const add = findSub(findSub(program, "mcp")!, "add")!;
    expect(flagNames(add)).toContain("--config-file");
  });
});

describe("registerSkillsCommand", () => {
  it("registers skills with list/resolved/add/rm/disable/enable", () => {
    const program = newProgram();
    registerSkillsCommand(program);
    const cmd = findSub(program, "skills")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "resolved", "add", "rm", "disable", "enable"]) {
      expect(findSub(cmd, sub), `missing: skills ${sub}`).toBeDefined();
    }
  });

  it("skills disable / enable require --level", () => {
    const program = newProgram();
    registerSkillsCommand(program);
    const cmd = findSub(program, "skills")!;
    for (const sub of ["disable", "enable"]) {
      expect(flagNames(findSub(cmd, sub)!), `${sub} missing --level`).toContain("--level");
    }
  });
});

describe("registerTemplatesCommand", () => {
  it("registers templates with list/show/add/update/rm", () => {
    const program = newProgram();
    registerTemplatesCommand(program);
    const cmd = findSub(program, "templates")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "show", "add", "update", "rm"]) {
      expect(findSub(cmd, sub), `missing: templates ${sub}`).toBeDefined();
    }
  });

  it("templates add / update require --file", () => {
    const program = newProgram();
    registerTemplatesCommand(program);
    const cmd = findSub(program, "templates")!;
    for (const sub of ["add", "update"]) {
      expect(flagNames(findSub(cmd, sub)!), `${sub} missing --file`).toContain("--file");
    }
  });
});

describe("registerSchedulesCommand", () => {
  it("registers schedules with all subcommands", () => {
    const program = newProgram();
    registerSchedulesCommand(program);
    const cmd = findSub(program, "schedules")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "show", "add", "rm", "pause", "resume", "runs"]) {
      expect(findSub(cmd, sub), `missing: schedules ${sub}`).toBeDefined();
    }
  });

  it("schedules add requires --cron / --template-scope / --template-name", () => {
    const program = newProgram();
    registerSchedulesCommand(program);
    const add = findSub(findSub(program, "schedules")!, "add")!;
    const flags = flagNames(add);
    for (const f of ["--cron", "--template-scope", "--template-name"]) {
      expect(flags, `add missing ${f}`).toContain(f);
    }
  });
});
