/**
 * `flockctl project ...` — CLI surface over the /projects HTTP API.
 *
 * We keep each action thin: validate args, build the POST/PATCH/DELETE body,
 * delegate to `DaemonClient`, and print a short confirmation. Anything that
 * requires filesystem state (git clone, .flockctl scaffold, AGENTS.md
 * adoption, reconcile queueing) happens inside the daemon — the CLI just
 * drives the API.
 *
 * The `add` / `add-cwd` flow calls `POST /projects/scan` first and refuses to
 * import when unmanaged AGENTS.md / CLAUDE.md / .mcp.json / /skills files are
 * present, unless the user passes the matching `--adopt-*` flag or a blanket
 * `--yes`. That matches the "Create Project" dialog in the UI.
 */
import type { Command } from "commander";
import { resolve as resolvePath } from "path";
import { basename } from "path";
import { rmSync } from "fs";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import type { ImportAction, ProjectScan } from "../services/project-import.js";
import {
  resolveByIdOrName,
  printRowTable,
  printJson,
  type ListResponse,
  type NamedRow,
} from "./_shared.js";

interface ProjectRow extends NamedRow {
  id: number;
  name: string;
  description: string | null;
  path: string | null;
  repoUrl: string | null;
  workspaceId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface AddOptions {
  name?: string;
  description?: string;
  workspace?: string;
  repoUrl?: string;
  allowedKeyIds?: string;
  adoptAgentsMd?: boolean;
  mergeClaudeMd?: boolean;
  importMcpJson?: boolean;
  yes?: boolean;
  json?: boolean;
}

/**
 * Parse the `--allowed-key-ids` comma-separated list into an array of
 * positive integers. Throws on shape errors; the daemon handles unknown /
 * inactive ID rejection server-side.
 */
function parseAllowedKeyIdsFlag(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = parseInt(s, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --allowed-key-ids entry: ${s}`);
      }
      return n;
    });
  return ids;
}

function buildImportActions(
  scan: ProjectScan,
  opts: AddOptions,
): { actions: ImportAction[]; unresolvedConflicts: string[] } {
  const actions: ImportAction[] = [];
  const unresolved: string[] = [];
  const yes = opts.yes === true;

  // AGENTS.md — if present and not managed, needs either --adopt-agents-md or --yes.
  if (scan.conflicts.agentsMd.present && !scan.conflicts.agentsMd.isManaged) {
    if (opts.adoptAgentsMd || yes) {
      actions.push({ kind: "adoptAgentsMd" });
    } else {
      unresolved.push(
        `AGENTS.md (${scan.conflicts.agentsMd.bytes} bytes) — rerun with --adopt-agents-md to import`,
      );
    }
  }

  // CLAUDE.md — only offer when it's a real file differing from AGENTS.md.
  if (
    scan.conflicts.claudeMd.present &&
    scan.conflicts.claudeMd.kind === "file" &&
    !scan.conflicts.claudeMd.sameAsAgents
  ) {
    if (opts.mergeClaudeMd || yes) {
      actions.push({ kind: "mergeClaudeMd" });
    } else {
      unresolved.push(
        `CLAUDE.md (${scan.conflicts.claudeMd.bytes} bytes) — rerun with --merge-claude-md to merge`,
      );
    }
  }

  // .mcp.json — only matters if it declares at least one server.
  if (scan.conflicts.mcpJson.present && scan.conflicts.mcpJson.servers.length > 0) {
    if (opts.importMcpJson || yes) {
      actions.push({ kind: "importMcpJson" });
    } else {
      unresolved.push(
        `.mcp.json (servers: ${scan.conflicts.mcpJson.servers.join(", ")}) — rerun with --import-mcp-json to import`,
      );
    }
  }

  // Claude skills: under --yes only; no dedicated flag, this is the escape hatch.
  if (scan.conflicts.claudeSkills.length > 0 && yes) {
    for (const s of scan.conflicts.claudeSkills) {
      if (!s.isSymlink) actions.push({ kind: "importClaudeSkill", name: s.name });
    }
  }

  return { actions, unresolvedConflicts: unresolved };
}

async function runAdd(path: string, opts: AddOptions): Promise<void> {
  const absPath = resolvePath(path);
  const client = createDaemonClient();

  // 1. Scan for conflicts first. The API endpoint is pure read-only.
  const scan = await client.post<ProjectScan>("/projects/scan", { path: absPath });

  if (scan.alreadyManaged && !opts.yes) {
    console.error(
      `Error: ${absPath} is already a flockctl project (contains .flockctl/). ` +
        `Re-run with --yes to overwrite.`,
    );
    process.exit(1);
  }

  const { actions, unresolvedConflicts } = buildImportActions(scan, opts);
  if (unresolvedConflicts.length > 0) {
    console.error(`Path contains existing files that need an explicit decision:`);
    for (const line of unresolvedConflicts) console.error(`  - ${line}`);
    console.error(
      `\nOr pass --yes to accept all proposed actions: ${scan.proposedActions
        .map((a) => a.kind)
        .join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  // 2. Resolve --workspace (optional id or name) into a numeric workspaceId.
  let workspaceId: number | null = null;
  if (opts.workspace) {
    const ws = await resolveByIdOrName<NamedRow>(client, "workspaces", opts.workspace);
    workspaceId = ws.id;
  }

  const name = opts.name?.trim() || basename(absPath);
  if (!name) {
    console.error("Error: could not derive project name; pass --name.");
    process.exit(1);
  }

  // 3. Create.
  const allowedKeyIds = parseAllowedKeyIdsFlag(opts.allowedKeyIds);
  const body: Record<string, unknown> = {
    name,
    path: absPath,
    description: opts.description ?? null,
    repoUrl: opts.repoUrl ?? undefined,
    workspaceId: workspaceId ?? undefined,
    importActions: actions,
    ...(allowedKeyIds !== undefined && { allowedKeyIds }),
  };

  const created = await client.post<ProjectRow>("/projects", body);

  if (opts.json) {
    printJson(created);
    return;
  }

  console.log(`Created project #${created.id}: ${created.name}`);
  console.log(`  path: ${created.path}`);
  if (created.workspaceId !== null) console.log(`  workspace: #${created.workspaceId}`);
  if (actions.length > 0) {
    console.log(`  import actions applied: ${actions.map((a) => a.kind).join(", ")}`);
  }
}

export function registerProjectCommand(program: Command): void {
  const projectCmd = program
    .command("project")
    .description("Manage projects (create, list, inspect, delete)");

  projectCmd
    .command("add <path>")
    .description(
      "Register a directory as a flockctl project. " +
        "Scans for existing AGENTS.md / CLAUDE.md / .mcp.json first and refuses " +
        "to proceed unless the relevant --adopt-* / --merge-* flag (or --yes) is passed.",
    )
    .option("-n, --name <name>", "Project name (default: directory basename)")
    .option("-d, --description <text>", "Human-readable description")
    .option("-w, --workspace <id|name>", "Attach project to this workspace")
    .option("--repo-url <url>", "Git remote URL to record on the project")
    .option(
      "-k, --allowed-key-ids <ids>",
      "Comma-separated numeric AI-provider-key IDs this project is allowed to use. " +
        "At least one active key is required by the daemon on create.",
    )
    .option("--adopt-agents-md", "Import an existing AGENTS.md into .flockctl/AGENTS.md")
    .option("--merge-claude-md", "Merge an existing CLAUDE.md into .flockctl/AGENTS.md")
    .option("--import-mcp-json", "Adopt servers from an existing .mcp.json")
    .option("-y, --yes", "Accept all proposed import actions without prompting")
    .option("--json", "Print the created project as JSON")
    .action(async (path: string, opts: AddOptions) => {
      try {
        await runAdd(path, opts);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  projectCmd
    .command("add-cwd")
    .description("Shortcut for `flockctl project add <cwd>` using the current working directory.")
    .option("-n, --name <name>", "Project name (default: directory basename)")
    .option("-d, --description <text>", "Human-readable description")
    .option("-w, --workspace <id|name>", "Attach project to this workspace")
    .option("--repo-url <url>", "Git remote URL to record on the project")
    .option(
      "-k, --allowed-key-ids <ids>",
      "Comma-separated numeric AI-provider-key IDs this project is allowed to use. " +
        "At least one active key is required by the daemon on create.",
    )
    .option("--adopt-agents-md", "Import an existing AGENTS.md into .flockctl/AGENTS.md")
    .option("--merge-claude-md", "Merge an existing CLAUDE.md into .flockctl/AGENTS.md")
    .option("--import-mcp-json", "Adopt servers from an existing .mcp.json")
    .option("-y, --yes", "Accept all proposed import actions without prompting")
    .option("--json", "Print the created project as JSON")
    .action(async (opts: AddOptions) => {
      try {
        await runAdd(process.cwd(), opts);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  projectCmd
    .command("scan <path>")
    .description("Dry-run: show what `project add <path>` would do, without touching the DB.")
    .option("--json", "Print the raw scan payload as JSON")
    .action(async (path: string, opts: { json?: boolean }) => {
      try {
        const absPath = resolvePath(path);
        const client = createDaemonClient();
        const scan = await client.post<ProjectScan>("/projects/scan", { path: absPath });
        if (opts.json) {
          printJson(scan);
          return;
        }
        console.log(`Scan of ${scan.path}`);
        console.log(`  exists:          ${scan.exists}`);
        console.log(`  writable:        ${scan.writable}`);
        console.log(`  git:             ${scan.git.present ? (scan.git.originUrl ?? "(no origin)") : "not a git repo"}`);
        console.log(`  already managed: ${scan.alreadyManaged}`);
        console.log(`  AGENTS.md:       ${scan.conflicts.agentsMd.present ? `${scan.conflicts.agentsMd.bytes} B (managed=${scan.conflicts.agentsMd.isManaged})` : "absent"}`);
        console.log(`  CLAUDE.md:       ${scan.conflicts.claudeMd.present ? `${scan.conflicts.claudeMd.kind}, ${scan.conflicts.claudeMd.bytes} B` : "absent"}`);
        console.log(`  .mcp.json:       ${scan.conflicts.mcpJson.present ? `servers=[${scan.conflicts.mcpJson.servers.join(", ")}]` : "absent"}`);
        if (scan.conflicts.claudeSkills.length > 0) {
          console.log(`  .claude/skills:  ${scan.conflicts.claudeSkills.map((s) => s.name + (s.isSymlink ? "*" : "")).join(", ")}`);
        }
        if (scan.proposedActions.length > 0) {
          console.log(`\nProposed import actions:`);
          for (const a of scan.proposedActions) {
            console.log(`  - ${a.kind}${"name" in a ? `: ${a.name}` : ""}`);
          }
        } else {
          console.log(`\nNo import actions needed.`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  projectCmd
    .command("list")
    .description("List all projects.")
    .option("-w, --workspace <id|name>", "Filter to projects in this workspace")
    .option("--json", "Print as JSON")
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<ListResponse<ProjectRow>>("/projects", { perPage: 500 });
        let items = res.items;
        if (opts.workspace) {
          const ws = await resolveByIdOrName<NamedRow>(client, "workspaces", opts.workspace);
          items = items.filter((p) => p.workspaceId === ws.id);
        }
        if (opts.json) {
          printJson(items);
          return;
        }
        printRowTable(items);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  projectCmd
    .command("show <idOrName>")
    .description("Show details for one project, including milestone summaries.")
    .option("--json", "Print as JSON")
    .action(async (ref: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const project = await resolveByIdOrName<ProjectRow & { milestones?: unknown[] }>(
          client,
          "projects",
          ref,
        );
        if (opts.json) {
          printJson(project);
          return;
        }
        console.log(`Project #${project.id}: ${project.name}`);
        if (project.description) console.log(`  description: ${project.description}`);
        console.log(`  path:        ${project.path ?? "(none)"}`);
        console.log(`  repoUrl:     ${project.repoUrl ?? "(none)"}`);
        console.log(`  workspace:   ${project.workspaceId !== null ? `#${project.workspaceId}` : "(standalone)"}`);
        console.log(`  createdAt:   ${project.createdAt}`);
        if (Array.isArray(project.milestones)) {
          console.log(`  milestones:  ${project.milestones.length}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  projectCmd
    .command("update <idOrName>")
    .description(
      "Update an existing project. Only the flags you pass are changed — " +
        "every other field keeps its current value. Works for both the DB " +
        "row fields (name, description, path, repoUrl) and the per-project " +
        "config fields that live in <project>/.flockctl/config.json " +
        "(model, planningModel, baseBranch, permissionMode).",
    )
    .option("-n, --name <name>", "Rename the project")
    .option("-d, --description <text>", "Replace the description")
    .option("-p, --path <dir>", "Change the on-disk path recorded for the project")
    .option("--repo-url <url>", "Update the git remote URL")
    .option("--model <model>", "Default model for tasks in this project")
    .option("--planning-model <model>", "Model used by the planner for this project")
    .option("--base-branch <branch>", "Base branch name (e.g. main)")
    .option(
      "--permission-mode <mode>",
      "Claude permission mode: default | plan | acceptEdits | bypassPermissions",
    )
    .option("--json", "Print the updated project as JSON")
    .action(async (
      ref: string,
      opts: {
        name?: string;
        description?: string;
        path?: string;
        repoUrl?: string;
        model?: string;
        planningModel?: string;
        baseBranch?: string;
        permissionMode?: string;
        json?: boolean;
      },
    ) => {
      try {
        const client = createDaemonClient();
        const project = await resolveByIdOrName<ProjectRow>(client, "projects", ref);

        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.path !== undefined) body.path = resolvePath(opts.path);
        if (opts.repoUrl !== undefined) body.repoUrl = opts.repoUrl;
        if (opts.model !== undefined) body.model = opts.model;
        if (opts.planningModel !== undefined) body.planningModel = opts.planningModel;
        if (opts.baseBranch !== undefined) body.baseBranch = opts.baseBranch;
        if (opts.permissionMode !== undefined) body.permissionMode = opts.permissionMode;

        if (Object.keys(body).length === 0) {
          console.error(
            "Error: no update flags passed. Supply at least one of " +
              "--name / --description / --path / --repo-url / --model / " +
              "--planning-model / --base-branch / --permission-mode.",
          );
          process.exit(1);
        }

        const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, body);

        if (opts.json) {
          printJson(updated);
          return;
        }
        console.log(`Updated project #${updated.id}: ${updated.name}`);
        for (const [k, v] of Object.entries(body)) {
          console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  // `project rm` — delete the project. `project remove` is kept as an alias so
  // users can spell out the full verb if they prefer it.
  const rmAction = async (
    ref: string,
    opts: { yes?: boolean; purge?: boolean },
  ): Promise<void> => {
    const client = createDaemonClient();
    const project = await resolveByIdOrName<ProjectRow>(client, "projects", ref);
    if (!opts.yes) {
      console.error(
        `Refusing to delete project #${project.id} "${project.name}" without --yes. ` +
          `Pass --yes to confirm.`,
      );
      process.exit(1);
    }
    await client.del(`/projects/${project.id}`);
    let purged = false;
    if (opts.purge && project.path) {
      try {
        rmSync(project.path, { recursive: true, force: true });
        purged = true;
        /* c8 ignore start — defensive: rmSync with force:true only throws on
           exotic filesystem errors (EBUSY, EPERM on immutable files, …) that
           we can't synthesize reliably inside a test container. The DB row
           has already been deleted; losing the on-disk dir is best-effort. */
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Warning: removed DB row but could not purge ${project.path}: ${msg}`,
        );
      }
      /* c8 ignore stop */
    }
    if (purged) {
      console.log(
        `Deleted project #${project.id}: ${project.name} (purged ${project.path})`,
      );
    } else {
      console.log(`Deleted project #${project.id}: ${project.name}`);
    }
  };

  projectCmd
    .command("rm <idOrName>")
    .alias("remove")
    .description(
      "Delete a project. Drops the DB row and project secrets. " +
        "With --purge the project's on-disk directory is also removed.",
    )
    .option("-y, --yes", "Skip the confirmation prompt (required in non-interactive runs)")
    .option(
      "--purge",
      "Also recursively delete the project directory from disk (dangerous, irreversible)",
    )
    .action(async (ref: string, opts: { yes?: boolean; purge?: boolean }) => {
      try {
        await rmAction(ref, opts);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
