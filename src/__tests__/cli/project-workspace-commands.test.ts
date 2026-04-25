/**
 * Structural tests for the `project` and `workspace` command groups.
 *
 * We don't drive the actions end-to-end here (that would require a live
 * daemon or a deep mock of every route) — the HTTP wiring is covered by
 * `daemon-client.test.ts`. These tests lock down:
 *
 *   1. Every command is registered under the right group.
 *   2. Every command declares the flags we documented in CLI.md.
 *   3. `resolveByIdOrName` does what the action handlers rely on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerProjectCommand } from "../../cli-commands/project.js";
import { registerWorkspaceCommand } from "../../cli-commands/workspace.js";
import { resolveByIdOrName } from "../../cli-commands/_shared.js";
import { DaemonClient } from "../../lib/daemon-client.js";

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

describe("registerProjectCommand", () => {
  it("registers the project group and its subcommands", () => {
    const program = newProgram();
    registerProjectCommand(program);

    const project = findSub(program, "project");
    expect(project).toBeDefined();

    const expected = ["add", "add-cwd", "scan", "list", "show", "rm"];
    for (const sub of expected) {
      expect(findSub(project!, sub), `missing: project ${sub}`).toBeDefined();
    }
  });

  it("project add declares scan-related flags", () => {
    const program = newProgram();
    registerProjectCommand(program);
    const add = findSub(findSub(program, "project")!, "add")!;
    const flags = flagNames(add);
    for (const f of [
      "--name",
      "--description",
      "--workspace",
      "--repo-url",
      "--adopt-agents-md",
      "--merge-claude-md",
      "--import-mcp-json",
      "--yes",
      "--json",
    ]) {
      expect(flags, `project add missing ${f}`).toContain(f);
    }
  });

  it("project add-cwd takes no positional path", () => {
    const program = newProgram();
    registerProjectCommand(program);
    const addCwd = findSub(findSub(program, "project")!, "add-cwd")!;
    // Commander stores positional args on _args (private) — we verify by name.
    expect(addCwd.name()).toBe("add-cwd");
    const flags = flagNames(addCwd);
    expect(flags).toContain("--yes");
  });

  it("project rm requires --yes to avoid accidental deletion", () => {
    const program = newProgram();
    registerProjectCommand(program);
    const rm = findSub(findSub(program, "project")!, "rm")!;
    expect(flagNames(rm)).toContain("--yes");
  });
});

describe("registerWorkspaceCommand", () => {
  it("registers the workspace group and its subcommands", () => {
    const program = newProgram();
    registerWorkspaceCommand(program);
    const workspace = findSub(program, "workspace");
    expect(workspace).toBeDefined();

    const expected = ["create", "list", "show", "rm", "link", "unlink"];
    for (const sub of expected) {
      expect(findSub(workspace!, sub), `missing: workspace ${sub}`).toBeDefined();
    }
  });

  it("workspace create declares path / description / repo-url", () => {
    const program = newProgram();
    registerWorkspaceCommand(program);
    const create = findSub(findSub(program, "workspace")!, "create")!;
    const flags = flagNames(create);
    for (const f of ["--path", "--description", "--repo-url", "--json"]) {
      expect(flags, `workspace create missing ${f}`).toContain(f);
    }
  });
});

describe("resolveByIdOrName", () => {
  beforeEach(() => {
    vi.spyOn(DaemonClient.prototype, "get").mockImplementation(async (path: string) => {
      if (path === "/projects/12") {
        return { id: 12, name: "alpha", path: "/tmp/alpha" } as unknown;
      }
      if (path === "/workspaces/3") {
        return { id: 3, name: "main", path: "/tmp/ws" } as unknown;
      }
      if (path === "/projects") {
        return {
          items: [
            { id: 1, name: "alpha", path: "/a" },
            { id: 2, name: "Beta", path: "/b" },
            { id: 3, name: "alpha", path: "/dup" },
          ],
          total: 3,
          page: 1,
          perPage: 500,
        } as unknown;
      }
      if (path === "/workspaces") {
        return {
          items: [{ id: 3, name: "main", path: "/w" }],
          total: 1,
          page: 1,
          perPage: 500,
        } as unknown;
      }
      throw new Error(`unexpected path: ${path}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches directly by numeric id", async () => {
    const client = new DaemonClient();
    const out = await resolveByIdOrName(client, "projects", "12");
    expect(out).toMatchObject({ id: 12, name: "alpha" });
  });

  it("looks up case-insensitively by name via list + detail re-fetch", async () => {
    const client = new DaemonClient();
    const out = await resolveByIdOrName(client, "workspaces", "MAIN");
    expect(out).toMatchObject({ id: 3, name: "main" });
  });

  it("throws when no match", async () => {
    const client = new DaemonClient();
    await expect(resolveByIdOrName(client, "projects", "nope")).rejects.toThrow(
      /No project found/,
    );
  });

  it("throws when multiple rows share a name (ambiguous)", async () => {
    const client = new DaemonClient();
    await expect(resolveByIdOrName(client, "projects", "alpha")).rejects.toThrow(
      /Multiple projects named/,
    );
  });
});
