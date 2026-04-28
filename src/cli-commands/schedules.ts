/**
 * `flockctl schedules ...` — manage cron-driven schedule rows that fire
 * a referenced template at the requested cadence.
 *
 * A schedule row carries:
 *   - cron expression (5-field, classic)
 *   - reference to a template (`scope` + `name`, plus workspace_id /
 *     project_id when the scope demands them)
 *   - optional `assignedKeyId` to scope the run to a specific provider key
 *
 * Subcommands:
 *   list                                   — paginated list, filterable
 *   show <id>                              — full row + resolved template
 *   add  --cron … --template-name … …      — create
 *   rm   <id>                              — delete
 *   pause <id> / resume <id>               — toggle status
 *   runs <id>                              — show past executions
 */
import type { Command } from "commander";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { resolveByIdOrName, printJson, type ListResponse, type NamedRow } from "./_shared.js";

interface ScheduleRow {
  id: number;
  scheduleType: string;
  cron: string;
  status: string;
  templateScope: string;
  templateName: string;
  templateWorkspaceId: number | null;
  templateProjectId: number | null;
  assignedKeyId: number | null;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export function registerSchedulesCommand(program: Command): void {
  const cmd = program
    .command("schedules")
    .description("Manage cron schedules that fire prompt templates.");

  cmd
    .command("list")
    .description("List schedules.")
    .option("--status <status>", "Filter by status (active, paused, ...)")
    .option("--type <scheduleType>", "Filter by schedule_type")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size", "100")
    .option("--json", "Print as JSON")
    .action(
      async (opts: {
        status?: string;
        type?: string;
        page?: string;
        perPage?: string;
        json?: boolean;
      }) => {
        try {
          const client = createDaemonClient();
          const res = await client.get<ListResponse<ScheduleRow>>("/schedules", {
            page: opts.page ?? "1",
            perPage: opts.perPage ?? "100",
            ...(opts.status && { status: opts.status }),
            ...(opts.type && { schedule_type: opts.type }),
          });
          if (opts.json) {
            printJson(res);
            return;
          }
          if (res.items.length === 0) {
            console.log("(no schedules)");
            return;
          }
          for (const s of res.items) {
            const next = s.nextRunAt ?? "—";
            console.log(
              `  #${s.id}  ${s.status.padEnd(8)}  ${s.cron.padEnd(15)}  ` +
                `${s.templateScope}:${s.templateName}  next=${next}`,
            );
          }
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("show <id>")
    .description("Show a schedule and its resolved template.")
    .option("--json", "Print as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const s = await client.get<ScheduleRow & { template?: unknown }>(`/schedules/${id}`);
        if (opts.json) {
          printJson(s);
          return;
        }
        console.log(`Schedule #${s.id} [${s.status}]`);
        console.log(`  cron:        ${s.cron}`);
        console.log(`  type:        ${s.scheduleType}`);
        console.log(`  template:    ${s.templateScope}:${s.templateName}`);
        if (s.templateWorkspaceId) console.log(`  ws#${s.templateWorkspaceId}`);
        if (s.templateProjectId) console.log(`  proj#${s.templateProjectId}`);
        console.log(`  lastRunAt:   ${s.lastRunAt ?? "(never)"}`);
        console.log(`  nextRunAt:   ${s.nextRunAt ?? "(unscheduled)"}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("add")
    .description("Create a new schedule referencing an existing template.")
    .requiredOption("--cron <expr>", "5-field cron expression (e.g. \"0 * * * *\")")
    .requiredOption("--template-scope <scope>", "global | workspace | project")
    .requiredOption("--template-name <name>", "Template name")
    .option("--type <scheduleType>", "Schedule type (default: \"cron\")", "cron")
    .option("--template-workspace <idOrName>", "Workspace for workspace-scoped templates")
    .option("--template-project <idOrName>", "Project for project-scoped templates")
    .option("--key-id <id>", "Pin runs to a specific AI provider key id")
    .option("--json", "Print the created row as JSON")
    .action(
      async (opts: {
        cron: string;
        type?: string;
        templateScope: string;
        templateName: string;
        templateWorkspace?: string;
        templateProject?: string;
        keyId?: string;
        json?: boolean;
      }) => {
        try {
          const client = createDaemonClient();
          const body: Record<string, unknown> = {
            scheduleType: opts.type ?? "cron",
            cron: opts.cron,
            templateScope: opts.templateScope,
            templateName: opts.templateName,
          };
          if (opts.templateWorkspace) {
            const ws = await resolveByIdOrName<NamedRow>(
              client,
              "workspaces",
              opts.templateWorkspace,
            );
            body.templateWorkspaceId = ws.id;
          }
          if (opts.templateProject) {
            const p = await resolveByIdOrName<NamedRow>(client, "projects", opts.templateProject);
            body.templateProjectId = p.id;
          }
          if (opts.keyId) body.assignedKeyId = parseInt(opts.keyId, 10);
          const created = await client.post<ScheduleRow>("/schedules", body);
          if (opts.json) {
            printJson(created);
            return;
          }
          console.log(`Created schedule #${created.id}: ${created.cron} → ${created.templateScope}:${created.templateName}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("rm <id>")
    .alias("remove")
    .description("Delete a schedule.")
    .action(async (id: string) => {
      try {
        const client = createDaemonClient();
        await client.del(`/schedules/${id}`);
        console.log(`Removed schedule #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  for (const action of ["pause", "resume"] as const) {
    cmd
      .command(`${action} <id>`)
      .description(`${action === "pause" ? "Pause" : "Resume"} a schedule.`)
      .action(async (id: string) => {
        try {
          const client = createDaemonClient();
          await client.patch<ScheduleRow>(`/schedules/${id}`, {
            status: action === "pause" ? "paused" : "active",
          });
          console.log(`${action === "pause" ? "Paused" : "Resumed"} schedule #${id}`);
        } catch (err) {
          exitWithDaemonError(err);
        }
      });
  }

  cmd
    .command("runs <id>")
    .description("List past executions of a schedule.")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size", "50")
    .option("--json", "Print as JSON")
    .action(
      async (
        id: string,
        opts: { page?: string; perPage?: string; json?: boolean },
      ) => {
        try {
          const client = createDaemonClient();
          const res = await client.get<ListResponse<{ id: number; status: string; startedAt: string; finishedAt: string | null }>>(
            `/schedules/${id}/runs`,
            {
              page: opts.page ?? "1",
              perPage: opts.perPage ?? "50",
            },
          );
          if (opts.json) {
            printJson(res);
            return;
          }
          if (res.items.length === 0) {
            console.log("(no runs)");
            return;
          }
          for (const r of res.items) {
            console.log(`  #${r.id}  ${r.status.padEnd(10)}  ${r.startedAt} → ${r.finishedAt ?? "(still running)"}`);
          }
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );
}
