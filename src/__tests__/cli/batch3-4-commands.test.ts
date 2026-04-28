/**
 * Structural tests for batch 3 and 4 CLI commands.
 *
 * Batch 3: chats, logs, incidents, metrics, usage, fs.
 * Batch 4: config, backup, restore, migrate, open.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerChatsCommand } from "../../cli-commands/chats.js";
import { registerLogsCommand } from "../../cli-commands/logs.js";
import { registerIncidentsCommand } from "../../cli-commands/incidents.js";
import {
  registerMetricsCommand,
  registerUsageCommand,
} from "../../cli-commands/metrics.js";
import { registerFsCommand } from "../../cli-commands/fs.js";
import { registerConfigCommand } from "../../cli-commands/config.js";
import { registerBackupCommand } from "../../cli-commands/backup.js";
import { registerMigrateCommand } from "../../cli-commands/migrate.js";
import { registerOpenCommand } from "../../cli-commands/open.js";

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

describe("registerChatsCommand", () => {
  it("registers chats with all subcommands", () => {
    const program = newProgram();
    registerChatsCommand(program);
    const cmd = findSub(program, "chats")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "show", "send", "cancel", "approve", "reject", "rm", "tail"]) {
      expect(findSub(cmd, sub), `missing: chats ${sub}`).toBeDefined();
    }
  });
});

describe("registerLogsCommand", () => {
  it("registers logs with --tail / --follow / --path", () => {
    const program = newProgram();
    registerLogsCommand(program);
    const cmd = findSub(program, "logs")!;
    expect(cmd).toBeDefined();
    const flags = flagNames(cmd);
    for (const f of ["--tail", "--follow", "--path"]) {
      expect(flags, `logs missing ${f}`).toContain(f);
    }
  });
});

describe("registerIncidentsCommand", () => {
  it("registers incidents with list/show/add/update/rm/tags", () => {
    const program = newProgram();
    registerIncidentsCommand(program);
    const cmd = findSub(program, "incidents")!;
    expect(cmd).toBeDefined();
    for (const sub of ["list", "show", "add", "update", "rm", "tags"]) {
      expect(findSub(cmd, sub), `missing: incidents ${sub}`).toBeDefined();
    }
  });

  it("incidents add requires --title", () => {
    const program = newProgram();
    registerIncidentsCommand(program);
    const add = findSub(findSub(program, "incidents")!, "add")!;
    expect(flagNames(add)).toContain("--title");
  });
});

describe("registerMetricsCommand", () => {
  it("registers metrics with overview", () => {
    const program = newProgram();
    registerMetricsCommand(program);
    const cmd = findSub(program, "metrics")!;
    expect(cmd).toBeDefined();
    expect(findSub(cmd, "overview")).toBeDefined();
  });
});

describe("registerUsageCommand", () => {
  it("registers usage with summary/breakdown/records/budgets", () => {
    const program = newProgram();
    registerUsageCommand(program);
    const cmd = findSub(program, "usage")!;
    expect(cmd).toBeDefined();
    for (const sub of ["summary", "breakdown", "records", "budgets"]) {
      expect(findSub(cmd, sub), `missing: usage ${sub}`).toBeDefined();
    }
  });
});

describe("registerFsCommand", () => {
  it("registers fs with ls", () => {
    const program = newProgram();
    registerFsCommand(program);
    const cmd = findSub(program, "fs")!;
    expect(cmd).toBeDefined();
    expect(findSub(cmd, "ls")).toBeDefined();
  });
});

describe("registerConfigCommand", () => {
  it("registers config with path/list/get/set/unset", () => {
    const program = newProgram();
    registerConfigCommand(program);
    const cmd = findSub(program, "config")!;
    expect(cmd).toBeDefined();
    for (const sub of ["path", "list", "get", "set", "unset"]) {
      expect(findSub(cmd, sub), `missing: config ${sub}`).toBeDefined();
    }
  });
});

describe("registerBackupCommand", () => {
  it("registers backup and restore as top-level commands", () => {
    const program = newProgram();
    registerBackupCommand(program);
    expect(findSub(program, "backup")).toBeDefined();
    expect(findSub(program, "restore")).toBeDefined();
  });

  it("restore exposes --force", () => {
    const program = newProgram();
    registerBackupCommand(program);
    const restore = findSub(program, "restore")!;
    expect(flagNames(restore)).toContain("--force");
  });
});

describe("registerMigrateCommand", () => {
  it("registers migrate with status and up", () => {
    const program = newProgram();
    registerMigrateCommand(program);
    const cmd = findSub(program, "migrate")!;
    expect(cmd).toBeDefined();
    expect(findSub(cmd, "status")).toBeDefined();
    expect(findSub(cmd, "up")).toBeDefined();
  });
});

describe("registerOpenCommand", () => {
  it("registers open with --host / --port / --url / --print", () => {
    const program = newProgram();
    registerOpenCommand(program);
    const cmd = findSub(program, "open")!;
    expect(cmd).toBeDefined();
    const flags = flagNames(cmd);
    for (const f of ["--host", "--port", "--url", "--print"]) {
      expect(flags, `open missing ${f}`).toContain(f);
    }
  });

  it("open --print emits a well-formed URL on stdout", () => {
    const program = newProgram();
    registerOpenCommand(program);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0]));
    };
    try {
      program.parse([
        "node",
        "flockctl",
        "open",
        "--print",
        "--host",
        "127.0.0.1",
        "--port",
        "52077",
        "--url",
        "/tasks",
      ]);
      expect(logs[0]).toBe("http://127.0.0.1:52077/tasks");
    } finally {
      console.log = orig;
    }
  });
});
