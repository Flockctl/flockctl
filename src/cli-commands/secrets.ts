/**
 * `flockctl secrets ...` — manage scoped environment variables that get
 * injected into agent sessions and MCP servers.
 *
 * Three scopes mirror the API surface:
 *   - `global`               → applies to every workspace + project
 *   - `workspace <idOrName>` → cascades into all projects in the workspace
 *   - `project <idOrName>`   → strictly scoped to one project
 *
 * Set semantics:
 *   - `secrets set NAME` reads the value from stdin so the literal never
 *     ends up in shell history or argv. We refuse `--value` on purpose —
 *     the convenience isn't worth the leak risk. (`echo $TOKEN | flockctl
 *     secrets set FOO_TOKEN` is the supported pattern.)
 *   - The list output never prints values (only names + scope + truncated
 *     description). The full value is intentionally not retrievable from
 *     the API, so even `--json` returns no value field.
 *
 * After every mutation the daemon kicks an MCP-config reconcile so MCP
 * servers see the new secret on next launch — that's why we don't try
 * to expose the queue to the CLI directly.
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import {
  resolveByIdOrName,
  printJson,
  type NamedRow,
} from "./_shared.js";

interface SecretRow {
  id: number;
  scope: "global" | "workspace" | "project";
  scopeId: number | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

type Scope = "global" | "workspace" | "project";

function scopePath(scope: Scope, scopeId: number | null): string {
  if (scope === "global") return "/secrets/global";
  if (scope === "workspace") return `/secrets/workspaces/${scopeId}`;
  return `/secrets/projects/${scopeId}`;
}

async function resolveScope(
  client: ReturnType<typeof createDaemonClient>,
  scope: Scope,
  ref: string | undefined,
): Promise<{ scope: Scope; scopeId: number | null }> {
  if (scope === "global") return { scope, scopeId: null };
  if (!ref) {
    throw new Error(`--${scope} <idOrName> is required for ${scope}-scoped secrets`);
  }
  const collection = scope === "workspace" ? "workspaces" : "projects";
  const row = await resolveByIdOrName<NamedRow>(client, collection, ref);
  return { scope, scopeId: row.id };
}

function readValueFromStdinOrFail(): string {
  // 0 is the file descriptor for stdin. readFileSync(0) reads until EOF —
  // that's why this command refuses to run interactively (no piped data
  // would block forever, but we'd rather print a hint).
  if (process.stdin.isTTY) {
    process.stderr.write(
      "Error: secrets set reads the value from stdin. Pipe it in:\n" +
        "  echo -n \"$TOKEN\" | flockctl secrets set NAME\n",
    );
    process.exit(1);
  }
  return readFileSync(0, "utf-8");
}

function pickScopeFromOpts(opts: { workspace?: string; project?: string }): Scope {
  if (opts.workspace && opts.project) {
    throw new Error("Pass at most one of --workspace / --project (or neither for --global).");
  }
  if (opts.workspace) return "workspace";
  if (opts.project) return "project";
  return "global";
}

function pickScopeRef(scope: Scope, opts: { workspace?: string; project?: string }): string | undefined {
  if (scope === "workspace") return opts.workspace;
  if (scope === "project") return opts.project;
  return undefined;
}

export function registerSecretsCommand(program: Command): void {
  const cmd = program
    .command("secrets")
    .description("Manage scoped environment variables (global / workspace / project).");

  cmd
    .command("list")
    .description("List secrets at a given scope (names + descriptions; never values).")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .option("--json", "Print as JSON")
    .action(async (opts: { workspace?: string; project?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const scope = pickScopeFromOpts(opts);
        const { scopeId } = await resolveScope(client, scope, pickScopeRef(scope, opts));
        const res = await client.get<{ secrets: SecretRow[] }>(scopePath(scope, scopeId));
        if (opts.json) {
          printJson(res.secrets);
          return;
        }
        if (res.secrets.length === 0) {
          console.log("(no secrets)");
          return;
        }
        const nameW = Math.max(4, ...res.secrets.map((s) => s.name.length));
        console.log(`${"NAME".padEnd(nameW)}  DESCRIPTION`);
        for (const s of res.secrets) {
          console.log(`${s.name.padEnd(nameW)}  ${s.description ?? ""}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("set <name>")
    .description(
      "Set / replace a secret. Value is read from stdin to keep it out of " +
        "shell history. Refuses to run when stdin is a TTY.",
    )
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .option("-d, --description <text>", "Optional description")
    .action(
      async (
        name: string,
        opts: { workspace?: string; project?: string; description?: string },
      ) => {
        try {
          const client = createDaemonClient();
          const scope = pickScopeFromOpts(opts);
          const { scopeId } = await resolveScope(client, scope, pickScopeRef(scope, opts));
          const value = readValueFromStdinOrFail();
          await client.post(scopePath(scope, scopeId), {
            name,
            value,
            ...(opts.description !== undefined && { description: opts.description }),
          });
          console.log(
            `Set ${scope}${scopeId !== null ? `(#${scopeId})` : ""} secret: ${name}`,
          );
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("rm <name>")
    .alias("remove")
    .description("Delete a secret by name at the given scope.")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .action(
      async (name: string, opts: { workspace?: string; project?: string }) => {
        try {
          const client = createDaemonClient();
          const scope = pickScopeFromOpts(opts);
          const { scopeId } = await resolveScope(client, scope, pickScopeRef(scope, opts));
          await client.del(`${scopePath(scope, scopeId)}/${encodeURIComponent(name)}`);
          console.log(
            `Removed ${scope}${scopeId !== null ? `(#${scopeId})` : ""} secret: ${name}`,
          );
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );
}
