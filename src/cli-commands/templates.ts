/**
 * `flockctl templates ...` — manage task/chat prompt templates that live
 * on disk and are addressable by `(scope, name)`.
 *
 * Identity is `(scope, name)` plus an optional workspace_id / project_id
 * for non-global scopes. There is no numeric id — that's by design,
 * templates are user-renamable and migrate-friendly.
 *
 * Subcommands:
 *   list                       — paginated list, filterable by scope
 *   show <scope> <name>        — fetch one template's content
 *   add  <scope> <name>        — create from file or stdin
 *   update <scope> <name>      — replace content (rename via daemon-side flags)
 *   rm   <scope> <name>        — delete
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { resolveByIdOrName, printJson, type ListResponse, type NamedRow } from "./_shared.js";

type Scope = "global" | "workspace" | "project";

interface TemplateRow {
  scope: Scope;
  name: string;
  content: string;
  workspaceId: number | null;
  projectId: number | null;
  updatedAt?: string;
}

function readContent(path: string): string {
  if (path === "-") return readFileSync(0, "utf-8");
  return readFileSync(resolvePath(path), "utf-8");
}

function isScope(s: string): s is Scope {
  return s === "global" || s === "workspace" || s === "project";
}

async function resolveScopeIds(
  client: ReturnType<typeof createDaemonClient>,
  scope: Scope,
  workspaceRef?: string,
  projectRef?: string,
): Promise<{ workspaceId?: number; projectId?: number }> {
  const out: { workspaceId?: number; projectId?: number } = {};
  if (scope === "workspace") {
    if (!workspaceRef) throw new Error("workspace scope requires --workspace");
    const ws = await resolveByIdOrName<NamedRow>(client, "workspaces", workspaceRef);
    out.workspaceId = ws.id;
  }
  if (scope === "project") {
    if (!projectRef) throw new Error("project scope requires --project");
    const p = await resolveByIdOrName<NamedRow>(client, "projects", projectRef);
    out.projectId = p.id;
  }
  return out;
}

export function registerTemplatesCommand(program: Command): void {
  const cmd = program
    .command("templates")
    .description("Manage prompt templates (file-backed) at global / workspace / project scope.");

  cmd
    .command("list")
    .description("List templates.")
    .option("--scope <scope>", "Filter by scope: global | workspace | project")
    .option("-w, --workspace <idOrName>", "Workspace filter")
    .option("-p, --project <idOrName>", "Project filter")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size", "100")
    .option("--json", "Print as JSON")
    .action(
      async (opts: {
        scope?: string;
        workspace?: string;
        project?: string;
        page?: string;
        perPage?: string;
        json?: boolean;
      }) => {
        try {
          const client = createDaemonClient();
          const query: Record<string, string | number> = {
            page: opts.page ?? "1",
            perPage: opts.perPage ?? "100",
          };
          if (opts.scope) {
            if (!isScope(opts.scope)) {
              console.error(`Error: --scope must be global | workspace | project`);
              process.exit(1);
            }
            query.scope = opts.scope;
          }
          if (opts.workspace) {
            const ws = await resolveByIdOrName<NamedRow>(client, "workspaces", opts.workspace);
            query.workspace_id = ws.id;
          }
          if (opts.project) {
            const p = await resolveByIdOrName<NamedRow>(client, "projects", opts.project);
            query.project_id = p.id;
          }
          const res = await client.get<ListResponse<TemplateRow>>("/templates", query);
          if (opts.json) {
            printJson(res);
            return;
          }
          if (res.items.length === 0) {
            console.log("(no templates)");
            return;
          }
          const nameW = Math.max(4, ...res.items.map((t) => t.name.length));
          console.log(`${"SCOPE".padEnd(9)}  ${"NAME".padEnd(nameW)}  WS/PROJ`);
          for (const t of res.items) {
            const ids =
              t.workspaceId !== null
                ? `ws#${t.workspaceId}`
                : t.projectId !== null
                  ? `proj#${t.projectId}`
                  : "—";
            console.log(`${t.scope.padEnd(9)}  ${t.name.padEnd(nameW)}  ${ids}`);
          }
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("show <scope> <name>")
    .description("Print one template's full content.")
    .option("-w, --workspace <idOrName>", "Workspace (for workspace scope)")
    .option("-p, --project <idOrName>", "Project (for project scope)")
    .option("--json", "Print as JSON")
    .action(
      async (
        scopeArg: string,
        name: string,
        opts: { workspace?: string; project?: string; json?: boolean },
      ) => {
        try {
          if (!isScope(scopeArg)) {
            console.error(`Error: scope must be global | workspace | project`);
            process.exit(1);
          }
          const client = createDaemonClient();
          const ids = await resolveScopeIds(client, scopeArg, opts.workspace, opts.project);
          const t = await client.get<TemplateRow>(
            `/templates/${scopeArg}/${encodeURIComponent(name)}`,
            {
              ...(ids.workspaceId !== undefined && { workspace_id: ids.workspaceId }),
              ...(ids.projectId !== undefined && { project_id: ids.projectId }),
            },
          );
          if (opts.json) {
            printJson(t);
            return;
          }
          process.stdout.write(t.content);
          if (!t.content.endsWith("\n")) process.stdout.write("\n");
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("add <scope> <name>")
    .description("Create a template from a file (or `-` for stdin) at the given scope.")
    .requiredOption("-f, --file <path>", "Path to template content (use `-` for stdin)")
    .option("-w, --workspace <idOrName>", "Workspace (for workspace scope)")
    .option("-p, --project <idOrName>", "Project (for project scope)")
    .action(
      async (
        scopeArg: string,
        name: string,
        opts: { workspace?: string; project?: string; file: string },
      ) => {
        try {
          if (!isScope(scopeArg)) {
            console.error(`Error: scope must be global | workspace | project`);
            process.exit(1);
          }
          const client = createDaemonClient();
          const ids = await resolveScopeIds(client, scopeArg, opts.workspace, opts.project);
          const content = readContent(opts.file);
          await client.post("/templates", {
            scope: scopeArg,
            name,
            content,
            ...(ids.workspaceId !== undefined && { workspaceId: ids.workspaceId }),
            ...(ids.projectId !== undefined && { projectId: ids.projectId }),
          });
          console.log(`Created ${scopeArg} template: ${name}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("update <scope> <name>")
    .description("Replace a template's content.")
    .requiredOption("-f, --file <path>", "Path to new content (use `-` for stdin)")
    .option("-w, --workspace <idOrName>", "Workspace (for workspace scope)")
    .option("-p, --project <idOrName>", "Project (for project scope)")
    .action(
      async (
        scopeArg: string,
        name: string,
        opts: { workspace?: string; project?: string; file: string },
      ) => {
        try {
          if (!isScope(scopeArg)) {
            console.error(`Error: scope must be global | workspace | project`);
            process.exit(1);
          }
          const client = createDaemonClient();
          const ids = await resolveScopeIds(client, scopeArg, opts.workspace, opts.project);
          const content = readContent(opts.file);
          await client.patch(`/templates/${scopeArg}/${encodeURIComponent(name)}`, {
            content,
            ...(ids.workspaceId !== undefined && { workspaceId: ids.workspaceId }),
            ...(ids.projectId !== undefined && { projectId: ids.projectId }),
          });
          console.log(`Updated ${scopeArg} template: ${name}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("rm <scope> <name>")
    .alias("remove")
    .description("Delete a template.")
    .option("-w, --workspace <idOrName>", "Workspace (for workspace scope)")
    .option("-p, --project <idOrName>", "Project (for project scope)")
    .action(
      async (
        scopeArg: string,
        name: string,
        opts: { workspace?: string; project?: string },
      ) => {
        try {
          if (!isScope(scopeArg)) {
            console.error(`Error: scope must be global | workspace | project`);
            process.exit(1);
          }
          const client = createDaemonClient();
          const ids = await resolveScopeIds(client, scopeArg, opts.workspace, opts.project);
          // DELETE doesn't take a body in our client; send ids via query string.
          const qs = new URLSearchParams();
          if (ids.workspaceId !== undefined) qs.set("workspace_id", String(ids.workspaceId));
          if (ids.projectId !== undefined) qs.set("project_id", String(ids.projectId));
          const tail = qs.toString() ? `?${qs.toString()}` : "";
          await client.del(`/templates/${scopeArg}/${encodeURIComponent(name)}${tail}`);
          console.log(`Removed ${scopeArg} template: ${name}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );
}
