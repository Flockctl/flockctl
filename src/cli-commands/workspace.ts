/**
 * `flockctl workspace ...` — CLI surface over the /workspaces HTTP API.
 *
 * Workspaces are a thin container around projects: a directory with its own
 * .flockctl/ scaffold whose AGENTS.md + config cascade into every child
 * project. The CLI commands here map 1-to-1 onto the REST endpoints and do
 * not re-implement the scaffold — the daemon handles that on POST.
 */
import type { Command } from "commander";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import {
  resolveByIdOrName,
  printRowTable,
  printJson,
  type ListResponse,
  type NamedRow,
} from "./_shared.js";

interface WorkspaceRow extends NamedRow {
  id: number;
  name: string;
  description: string | null;
  path: string | null;
  repoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow extends NamedRow {
  id: number;
  name: string;
  path: string | null;
  workspaceId: number | null;
}

export function registerWorkspaceCommand(program: Command): void {
  const wsCmd = program
    .command("workspace")
    .description("Manage workspaces (containers that group related projects)");

  wsCmd
    .command("create <name>")
    .description(
      "Create a new workspace. If --path is omitted the daemon places it at " +
        "~/flockctl/workspaces/<slug>/; git is initialised and .flockctl/ is scaffolded.",
    )
    .option("-p, --path <dir>", "Local directory for the workspace (created if missing)")
    .option("-d, --description <text>", "Human-readable description")
    .option("--repo-url <url>", "Git remote URL — if set, the daemon clones it into --path")
    .option(
      "-k, --allowed-key-ids <ids>",
      "Comma-separated numeric AI-provider-key IDs this workspace is allowed to use. " +
        "At least one active key is required by the daemon on create.",
    )
    .option("--json", "Print the created workspace as JSON")
    .action(async (
      name: string,
      opts: {
        path?: string;
        description?: string;
        repoUrl?: string;
        allowedKeyIds?: string;
        json?: boolean;
      },
    ) => {
      try {
        const client = createDaemonClient();
        const body: Record<string, unknown> = { name };
        if (opts.path) body.path = resolvePath(opts.path);
        if (opts.description) body.description = opts.description;
        if (opts.repoUrl) body.repoUrl = opts.repoUrl;
        if (opts.allowedKeyIds) {
          const ids = opts.allowedKeyIds
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
          body.allowedKeyIds = ids;
        }
        // Git clone can be slow — give it a minute.
        const created = await client.request<WorkspaceRow>("/workspaces", {
          method: "POST",
          body,
          timeoutMs: 180_000,
        });
        if (opts.json) {
          printJson(created);
          return;
        }
        console.log(`Created workspace #${created.id}: ${created.name}`);
        console.log(`  path: ${created.path}`);
        if (created.repoUrl) console.log(`  repoUrl: ${created.repoUrl}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  wsCmd
    .command("list")
    .description("List all workspaces.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<ListResponse<WorkspaceRow>>("/workspaces", { perPage: 500 });
        if (opts.json) {
          printJson(res.items);
          return;
        }
        printRowTable(res.items);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  wsCmd
    .command("show <idOrName>")
    .description("Show details for one workspace, including the list of linked projects.")
    .option("--json", "Print as JSON")
    .action(async (ref: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const ws = await resolveByIdOrName<WorkspaceRow & { projects?: ProjectRow[] }>(
          client,
          "workspaces",
          ref,
        );
        if (opts.json) {
          printJson(ws);
          return;
        }
        console.log(`Workspace #${ws.id}: ${ws.name}`);
        if (ws.description) console.log(`  description: ${ws.description}`);
        console.log(`  path:        ${ws.path ?? "(none)"}`);
        console.log(`  repoUrl:     ${ws.repoUrl ?? "(none)"}`);
        console.log(`  createdAt:   ${ws.createdAt}`);
        if (Array.isArray(ws.projects) && ws.projects.length > 0) {
          console.log(`  projects (${ws.projects.length}):`);
          for (const p of ws.projects) {
            console.log(`    #${p.id}  ${p.name}  ${p.path ?? ""}`);
          }
        } else {
          console.log(`  projects:    (none)`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  wsCmd
    .command("rm <idOrName>")
    .description(
      "Delete a workspace. Projects inside the workspace are NOT deleted — their " +
        "workspaceId is set to NULL so they become standalone.",
    )
    .option("-y, --yes", "Skip the confirmation prompt (required in non-interactive runs)")
    .action(async (ref: string, opts: { yes?: boolean }) => {
      try {
        const client = createDaemonClient();
        const ws = await resolveByIdOrName<WorkspaceRow>(client, "workspaces", ref);
        if (!opts.yes) {
          console.error(
            `Refusing to delete workspace #${ws.id} "${ws.name}" without --yes. ` +
              `Pass --yes to confirm. Child projects will be unlinked, not deleted.`,
          );
          process.exit(1);
        }
        await client.del(`/workspaces/${ws.id}`);
        console.log(`Deleted workspace #${ws.id}: ${ws.name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  wsCmd
    .command("link <workspace> <project>")
    .description("Attach an existing standalone project to a workspace.")
    .action(async (wsRef: string, projectRef: string) => {
      try {
        const client = createDaemonClient();
        const [ws, project] = await Promise.all([
          resolveByIdOrName<WorkspaceRow>(client, "workspaces", wsRef),
          resolveByIdOrName<ProjectRow>(client, "projects", projectRef),
        ]);
        await client.post(`/workspaces/${ws.id}/projects`, undefined, {
          project_id: project.id,
        });
        console.log(
          `Linked project #${project.id} "${project.name}" into workspace #${ws.id} "${ws.name}".`,
        );
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  wsCmd
    .command("unlink <workspace> <project>")
    .description("Detach a project from its workspace (the project becomes standalone).")
    .action(async (wsRef: string, projectRef: string) => {
      try {
        const client = createDaemonClient();
        const [ws, project] = await Promise.all([
          resolveByIdOrName<WorkspaceRow>(client, "workspaces", wsRef),
          resolveByIdOrName<ProjectRow>(client, "projects", projectRef),
        ]);
        await client.del(`/workspaces/${ws.id}/projects/${project.id}`);
        console.log(
          `Unlinked project #${project.id} "${project.name}" from workspace #${ws.id} "${ws.name}".`,
        );
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
