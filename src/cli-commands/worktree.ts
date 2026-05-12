/**
 * `flockctl worktree ...` — operator surface for per-task / per-chat git
 * worktrees (the `isolation = 'worktree'` opt-in introduced alongside
 * migration 0060).
 *
 * Three subcommands:
 *
 *   worktree list [--project <ref>]
 *     Snapshot of every Flockctl-managed worktree in scope. Mixes
 *     `git worktree list` output with the DB rows that point at those
 *     paths so the operator sees both ends:
 *       - registered + DB-tracked → `task #42` / `chat #7`
 *       - registered, no DB row    → orphan (something deleted the row
 *                                    out from under the worktree)
 *       - DB row, not registered   → stale (worktree dir went away)
 *
 *   worktree prune [--project <ref>]
 *     Cleanup-if-clean across every DB-tracked worktree in scope. Same
 *     semantics as `claude --worktree`'s exit prompt: clean dirs are
 *     removed (their owner row's `worktree_path` / `worktree_branch`
 *     NULLed), dirty dirs are preserved with a `dirty` reason. Reports
 *     counts so an operator can pipe to `--json` and feed it to
 *     telemetry.
 *
 *   worktree remove <task|chat> <id> [--force]
 *     Single-row teardown. Routes through the owner-scoped endpoints
 *     (DELETE /tasks/:id/worktree, DELETE /chats/:id/worktree) so the
 *     dirty-without-force gate stays the source of truth.
 */
import type { Command } from "commander";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { resolveByIdOrName, printJson, type NamedRow } from "./_shared.js";

interface WorktreeListEntry {
  projectId: number;
  projectName: string;
  projectPath: string;
  path: string;
  branch: string | null;
  owner: { kind: "task" | "chat"; id: number } | null;
  managed: boolean;
}

interface ListOpts {
  project?: string;
  json?: boolean;
}

interface PruneOpts {
  project?: string;
  json?: boolean;
}

interface RemoveOpts {
  force?: boolean;
}

interface PruneDetail {
  owner: { kind: "task" | "chat"; id: number };
  path: string;
  removed: boolean;
  reason: string;
}

async function resolveOptionalProjectId(
  client: ReturnType<typeof createDaemonClient>,
  ref: string | undefined,
): Promise<number | undefined> {
  if (!ref) return undefined;
  if (/^\d+$/.test(ref.trim())) return Number(ref.trim());
  const proj = await resolveByIdOrName<NamedRow>(client, "projects", ref);
  return proj.id;
}

export function registerWorktreeCommand(program: Command): void {
  const cmd = program
    .command("worktree")
    .description("Manage per-task / per-chat git worktrees (isolation='worktree').");

  cmd
    .command("list")
    .description("List Flockctl-managed worktrees, optionally scoped to one project.")
    .option("-p, --project <idOrName>", "Filter to one project")
    .option("--json", "Print the raw API payload")
    .action(async (opts: ListOpts) => {
      try {
        const client = createDaemonClient();
        const projectId = await resolveOptionalProjectId(client, opts.project);
        const url = projectId !== undefined ? `/worktrees?project_id=${projectId}` : "/worktrees";
        const res = await client.get<{ items: WorktreeListEntry[]; total: number }>(url);
        if (opts.json) {
          printJson(res);
          return;
        }
        if (res.items.length === 0) {
          console.log("No managed worktrees.");
          return;
        }
        for (const e of res.items) {
          const owner = e.owner ? `${e.owner.kind}#${e.owner.id}` : "ORPHAN";
          const flag = e.managed ? "" : " [stale/orphan]";
          console.log(`${e.projectName}: ${e.path} (${e.branch ?? "?"}) → ${owner}${flag}`);
        }
        console.log(`\n${res.total} worktree${res.total === 1 ? "" : "s"}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("prune")
    .description(
      "Cleanup-if-clean every Flockctl-managed worktree in scope. " +
        "Dirty worktrees are preserved.",
    )
    .option("-p, --project <idOrName>", "Limit pruning to one project")
    .option("--json", "Print the raw API payload")
    .action(async (opts: PruneOpts) => {
      try {
        const client = createDaemonClient();
        const projectId = await resolveOptionalProjectId(client, opts.project);
        const url = projectId !== undefined ? `/worktrees/prune?project_id=${projectId}` : "/worktrees/prune";
        const res = await client.post<{
          cleaned: number;
          preservedDirty: number;
          details: PruneDetail[];
        }>(url);
        if (opts.json) {
          printJson(res);
          return;
        }
        console.log(`Cleaned: ${res.cleaned}, preserved (dirty): ${res.preservedDirty}`);
        if (res.preservedDirty > 0) {
          console.log("\nDirty worktrees retained for review:");
          for (const d of res.details) {
            if (d.reason !== "dirty") continue;
            console.log(`  ${d.owner.kind}#${d.owner.id}: ${d.path}`);
          }
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("remove <kind> <id>")
    .description(
      "Tear down a single worktree. <kind> is `task` or `chat`. Refuses on " +
        "uncommitted changes unless --force is passed.",
    )
    .option("--force", "Discard a dirty worktree")
    .action(async (kind: string, id: string, opts: RemoveOpts) => {
      try {
        if (kind !== "task" && kind !== "chat") {
          console.error(`Error: unknown kind '${kind}' — must be 'task' or 'chat'`);
          process.exit(1);
        }
        const client = createDaemonClient();
        // Tasks expose DELETE /tasks/:id/worktree; chats expose the
        // same shape at DELETE /chats/:id/worktree (alias of POST
        // /chats/:id/end-session). Both honour `?force=true` and
        // return `{ removed, reason }`.
        const route = kind === "task" ? `/tasks/${id}/worktree` : `/chats/${id}/worktree`;
        const path = opts.force ? `${route}?force=true` : route;
        const res = await client.del<{ removed: boolean; reason: string }>(path);
        console.log(
          `${kind}#${id}: ${res.removed ? "worktree removed" : "kept"} (${res.reason})`,
        );
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
