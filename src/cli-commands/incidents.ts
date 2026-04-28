/**
 * `flockctl incidents ...` — manage post-mortem incident records.
 *
 * Incidents are a thin record describing a problem (symptom / root cause
 * / resolution / tags). They can be created standalone or extracted from
 * a chat (`/chats/:id/extract-incident`) — that flow lives in the UI;
 * the CLI exposes the bare CRUD.
 *
 * Subcommands:
 *   list                — paginated list, newest first
 *   show <id>           — full row
 *   add                 — create from flags
 *   update <id>         — patch fields
 *   rm <id>             — delete
 *   tags                — list distinct tags (optionally project-scoped)
 */
import type { Command } from "commander";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { resolveByIdOrName, printJson, type ListResponse, type NamedRow } from "./_shared.js";

interface IncidentRow {
  id: number;
  title: string;
  symptom: string | null;
  rootCause: string | null;
  resolution: string | null;
  tags: string[];
  projectId: number | null;
  createdByChatId: number | null;
  createdAt: string;
  updatedAt: string;
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function registerIncidentsCommand(program: Command): void {
  const cmd = program.command("incidents").description("Manage post-mortem incidents.");

  cmd
    .command("list")
    .description("List incidents, newest first.")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size", "50")
    .option("--json", "Print as JSON")
    .action(async (opts: { page?: string; perPage?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<ListResponse<IncidentRow>>("/incidents", {
          page: opts.page ?? "1",
          perPage: opts.perPage ?? "50",
        });
        if (opts.json) {
          printJson(res);
          return;
        }
        if (res.items.length === 0) {
          console.log("(no incidents)");
          return;
        }
        for (const inc of res.items) {
          const tags = inc.tags.length > 0 ? ` [${inc.tags.join(",")}]` : "";
          console.log(`  #${inc.id}  ${inc.title}${tags}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("show <id>")
    .description("Show one incident.")
    .option("--json", "Print as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const inc = await client.get<IncidentRow>(`/incidents/${id}`);
        if (opts.json) {
          printJson(inc);
          return;
        }
        console.log(`Incident #${inc.id}: ${inc.title}`);
        if (inc.tags.length) console.log(`  tags:        ${inc.tags.join(", ")}`);
        if (inc.symptom) console.log(`  symptom:     ${inc.symptom}`);
        if (inc.rootCause) console.log(`  rootCause:   ${inc.rootCause}`);
        if (inc.resolution) console.log(`  resolution:  ${inc.resolution}`);
        if (inc.projectId) console.log(`  project:     #${inc.projectId}`);
        if (inc.createdByChatId) console.log(`  fromChat:    #${inc.createdByChatId}`);
        console.log(`  createdAt:   ${inc.createdAt}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("add")
    .description("Create a new incident.")
    .requiredOption("-t, --title <text>", "Short title")
    .option("--symptom <text>", "What was observed")
    .option("--root-cause <text>", "Root cause analysis")
    .option("--resolution <text>", "How it was resolved")
    .option("--tags <csv>", "Comma-separated tags")
    .option("-p, --project <idOrName>", "Optional project to attach to")
    .option("--json", "Print created row as JSON")
    .action(
      async (opts: {
        title: string;
        symptom?: string;
        rootCause?: string;
        resolution?: string;
        tags?: string;
        project?: string;
        json?: boolean;
      }) => {
        try {
          const client = createDaemonClient();
          const body: Record<string, unknown> = { title: opts.title };
          if (opts.symptom !== undefined) body.symptom = opts.symptom;
          if (opts.rootCause !== undefined) body.rootCause = opts.rootCause;
          if (opts.resolution !== undefined) body.resolution = opts.resolution;
          const tags = parseTags(opts.tags);
          if (tags !== undefined) body.tags = tags;
          if (opts.project) {
            const p = await resolveByIdOrName<NamedRow>(client, "projects", opts.project);
            body.projectId = p.id;
          }
          const created = await client.post<IncidentRow>("/incidents", body);
          if (opts.json) {
            printJson(created);
            return;
          }
          console.log(`Created incident #${created.id}: ${created.title}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("update <id>")
    .description("Patch an incident's fields.")
    .option("-t, --title <text>", "Update title")
    .option("--symptom <text>")
    .option("--root-cause <text>")
    .option("--resolution <text>")
    .option("--tags <csv>", "Replace the full tag list")
    .option("--json", "Print updated row as JSON")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          symptom?: string;
          rootCause?: string;
          resolution?: string;
          tags?: string;
          json?: boolean;
        },
      ) => {
        try {
          const client = createDaemonClient();
          const body: Record<string, unknown> = {};
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.symptom !== undefined) body.symptom = opts.symptom;
          if (opts.rootCause !== undefined) body.rootCause = opts.rootCause;
          if (opts.resolution !== undefined) body.resolution = opts.resolution;
          const tags = parseTags(opts.tags);
          if (tags !== undefined) body.tags = tags;
          if (Object.keys(body).length === 0) {
            console.error("Error: no update flags passed.");
            process.exit(1);
          }
          const updated = await client.patch<IncidentRow>(`/incidents/${id}`, body);
          if (opts.json) {
            printJson(updated);
            return;
          }
          console.log(`Updated incident #${updated.id}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("rm <id>")
    .alias("remove")
    .description("Delete an incident.")
    .action(async (id: string) => {
      try {
        const client = createDaemonClient();
        await client.del(`/incidents/${id}`);
        console.log(`Removed incident #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("tags")
    .description("List distinct incident tags (optionally project-scoped).")
    .option("-p, --project <idOrName>", "Project filter")
    .option("--json", "Print as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const query: Record<string, string | number> = {};
        if (opts.project) {
          const p = await resolveByIdOrName<NamedRow>(client, "projects", opts.project);
          query.projectId = p.id;
        }
        const res = await client.get<{ tags: string[] }>("/incidents/tags", query);
        if (opts.json) {
          printJson(res.tags);
          return;
        }
        for (const t of res.tags) console.log(`  ${t}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
