/**
 * `flockctl mcp ...` — manage Model Context Protocol server configs at
 * global / workspace / project scope.
 *
 * Each scope is a directory of JSON files: one server per file. The
 * daemon writes/reads them through `/mcp/{global,workspaces/:id,projects/:id}`,
 * and any mutation triggers a reconcile so the next agent run picks up
 * the change.
 *
 * Subcommands:
 *   list                — list servers at the chosen scope
 *   add  <name>         — write the config from a file (or stdin via `-`)
 *   rm   <name>         — delete the server at the chosen scope
 *   resolved -p <p>     — show the merged set a project would actually see
 *
 * `add` accepts the JSON payload via `--config-file <path>` (or `-` for
 * stdin) so we don't have to wrestle with shell-quoted JSON on the
 * command line. The file content is parsed and forwarded as-is — the
 * daemon validates it.
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { printJson } from "./_shared.js";
import { pickScope, resolveScopeId, scopeBucketPath, type ScopeOpts } from "./_scope.js";

interface McpServerEntry {
  name: string;
  level: "global" | "workspace" | "project";
  config: Record<string, unknown>;
}

function readJsonFromFileOrStdin(path: string): unknown {
  const raw = path === "-" ? readFileSync(0, "utf-8") : readFileSync(resolvePath(path), "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${path === "-" ? "stdin" : path} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function registerMcpCommand(program: Command): void {
  const cmd = program
    .command("mcp")
    .description("Manage MCP server configs (global / workspace / project scope).");

  cmd
    .command("list")
    .description("List MCP servers at the chosen scope.")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .option("--json", "Print as JSON")
    .action(async (opts: ScopeOpts & { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const scope = pickScope(opts);
        const scopeId = await resolveScopeId(client, scope, opts);
        const servers = await client.get<McpServerEntry[]>(scopeBucketPath("mcp", scope, scopeId));
        if (opts.json) {
          printJson(servers);
          return;
        }
        if (servers.length === 0) {
          console.log("(no servers)");
          return;
        }
        const nameW = Math.max(4, ...servers.map((s) => s.name.length));
        for (const s of servers) {
          const cmdField = (s.config as { command?: string }).command ?? "(no command)";
          console.log(`  ${s.name.padEnd(nameW)}  ${cmdField}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("resolved")
    .description("Show the merged MCP server set a project would actually receive.")
    .option("-p, --project <idOrName>", "Project to resolve for")
    .option("--json", "Print as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const scopeId = await resolveScopeId(client, "project", opts);
        const servers = await client.get<McpServerEntry[]>(`/mcp/resolved`, {
          projectId: scopeId ?? undefined,
        });
        if (opts.json) {
          printJson(servers);
          return;
        }
        for (const s of servers) console.log(`  [${s.level}] ${s.name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("add <name>")
    .description("Write an MCP server config (JSON) at the chosen scope. Use `-c -` for stdin.")
    .requiredOption("-c, --config-file <path>", "Path to a JSON config file (or `-` for stdin)")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .action(
      async (
        name: string,
        opts: ScopeOpts & { configFile: string },
      ) => {
        try {
          const client = createDaemonClient();
          const scope = pickScope(opts);
          const scopeId = await resolveScopeId(client, scope, opts);
          const config = readJsonFromFileOrStdin(opts.configFile);
          await client.post(scopeBucketPath("mcp", scope, scopeId), { name, config });
          console.log(`Saved ${scope} MCP server: ${name}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("rm <name>")
    .alias("remove")
    .description("Delete an MCP server config at the chosen scope.")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .action(async (name: string, opts: ScopeOpts) => {
      try {
        const client = createDaemonClient();
        const scope = pickScope(opts);
        const scopeId = await resolveScopeId(client, scope, opts);
        await client.del(`${scopeBucketPath("mcp", scope, scopeId)}/${encodeURIComponent(name)}`);
        console.log(`Removed ${scope} MCP server: ${name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
