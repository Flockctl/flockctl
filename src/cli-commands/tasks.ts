/**
 * `flockctl tasks ...` — CLI surface over the /tasks HTTP API.
 *
 * Tasks are the unit of execution: an agent (Claude Code or Copilot) is
 * spawned with a prompt, runs against a project, and produces logs + a
 * git diff. The CLI lets you list, show, create, cancel, rerun, approve,
 * reject, and tail logs without opening the UI — which is what makes
 * flockctl useful in CI and from SSH sessions.
 *
 * The `logs --follow` mode polls `/tasks/:id/logs` rather than upgrading
 * to a WebSocket. That keeps the dependency surface minimal (no `ws`
 * client) and is good enough for human consumption — the daemon writes
 * logs straight to SQLite, so a 1 s poll catches every line. Real-time
 * WS streaming is a future optimisation, not a Day-1 requirement.
 *
 * Output contract:
 *   - `list` / `show` / `create` print human-friendly tables / blocks by
 *     default; `--json` emits the raw API payload for scripting.
 *   - `cancel` / `rerun` / `approve` / `reject` print a one-line
 *     confirmation on success and exit non-zero on any 4xx/5xx.
 *   - `logs` writes log content to stdout one line at a time so it can
 *     be piped to `grep`, `jq`, etc. Stream metadata (id, ts) goes to
 *     stderr only when --verbose.
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import {
  resolveByIdOrName,
  printJson,
  type ListResponse,
  type NamedRow,
} from "./_shared.js";

interface TaskRow {
  id: number;
  projectId: number | null;
  prompt: string | null;
  promptFile: string | null;
  agent: string;
  model: string | null;
  status: string;
  taskType: string;
  label: string | null;
  workingDir: string | null;
  requiresApproval: boolean;
  permissionMode: string | null;
  parentTaskId: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // Flat payload also carries assigned_key_label / actual_model_used / spec —
  // we only type the fields we render explicitly.
  [key: string]: unknown;
}

interface TaskLogRow {
  id: number;
  task_id: number;
  content: string;
  stream_type: "stdout" | "stderr" | string;
  timestamp: string;
}

interface ListOpts {
  project?: string;
  status?: string;
  type?: string;
  label?: string;
  page?: string;
  perPage?: string;
  includeSuperseded?: boolean;
  json?: boolean;
}

interface CreateOpts {
  project?: string;
  prompt?: string;
  promptFile?: string;
  agent?: string;
  model?: string;
  type?: string;
  label?: string;
  requiresApproval?: boolean;
  permissionMode?: string;
  json?: boolean;
}

interface LogsOpts {
  follow?: boolean;
  intervalMs?: string;
  verbose?: boolean;
}

const TERMINAL_STATUSES = new Set([
  "done",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

function formatTaskRow(t: TaskRow): string[] {
  const status = t.status.padEnd(10);
  const type = t.taskType.padEnd(10);
  const created = (t.createdAt ?? "").slice(0, 19);
  const promptOrFile = t.prompt
    ? t.prompt.slice(0, 60).replace(/\s+/g, " ")
    : t.promptFile
      ? `<file:${t.promptFile}>`
      : "(empty)";
  return [String(t.id), status, type, created, promptOrFile];
}

function printTaskTable(rows: TaskRow[]): void {
  if (rows.length === 0) {
    console.log("(no tasks)");
    return;
  }
  const cells = rows.map(formatTaskRow);
  const idW = Math.max(2, ...cells.map((r) => r[0]!.length));
  const header = [
    "ID".padEnd(idW),
    "STATUS".padEnd(10),
    "TYPE".padEnd(10),
    "CREATED",
    "PROMPT",
  ].join("  ");
  console.log(header);
  for (const row of cells) {
    row[0] = row[0]!.padEnd(idW);
    console.log(row.join("  "));
  }
}

async function resolveProjectId(
  client: ReturnType<typeof createDaemonClient>,
  ref: string | undefined,
): Promise<number | undefined> {
  if (!ref) return undefined;
  const project = await resolveByIdOrName<NamedRow>(client, "projects", ref);
  return project.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function followLogs(
  client: ReturnType<typeof createDaemonClient>,
  taskId: number,
  opts: LogsOpts,
): Promise<void> {
  const intervalMs = Math.max(250, parseInt(opts.intervalMs ?? "1000", 10) || 1000);
  let lastSeenId = 0;

  // Poll loop. Exits when the task reaches a terminal status AND no new logs
  // arrived in the last poll. We never block forever on an active task —
  // SIGINT (Ctrl-C) breaks the loop the conventional way.
  for (;;) {
    const logs = await client.get<{ items: TaskLogRow[] }>(`/tasks/${taskId}/logs`);
    const newRows = logs.items.filter((r) => r.id > lastSeenId);
    for (const row of newRows) {
      if (opts.verbose) {
        process.stderr.write(`[${row.timestamp} #${row.id} ${row.stream_type}]\n`);
      }
      const stream = row.stream_type === "stderr" ? process.stderr : process.stdout;
      stream.write(row.content.endsWith("\n") ? row.content : row.content + "\n");
      lastSeenId = row.id;
    }

    const task = await client.get<TaskRow>(`/tasks/${taskId}`);
    if (TERMINAL_STATUSES.has(task.status) && newRows.length === 0) {
      if (opts.verbose) {
        process.stderr.write(`[task ${taskId} reached terminal state: ${task.status}]\n`);
      }
      return;
    }
    await sleep(intervalMs);
  }
}

export function registerTasksCommand(program: Command): void {
  const tasksCmd = program
    .command("tasks")
    .description("Manage tasks (list, create, show, cancel, rerun, approve, reject, tail logs)");

  tasksCmd
    .command("list")
    .description("List tasks with optional filters.")
    .option("-p, --project <idOrName>", "Filter by project")
    .option("-s, --status <status>", "Filter by status (queued, running, done, failed, ...)")
    .option("-t, --type <taskType>", "Filter by task_type (execution, planning, ...)")
    .option("-l, --label <substring>", "Substring match against task label")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size (default 50)", "50")
    .option("--include-superseded", "Include failures whose retry already succeeded")
    .option("--json", "Print as JSON")
    .action(async (opts: ListOpts) => {
      try {
        const client = createDaemonClient();
        const projectId = await resolveProjectId(client, opts.project);
        const res = await client.get<ListResponse<TaskRow>>("/tasks", {
          page: opts.page ?? "1",
          perPage: opts.perPage ?? "50",
          ...(opts.status && { status: opts.status }),
          ...(projectId !== undefined && { project_id: projectId }),
          ...(opts.type && { task_type: opts.type }),
          ...(opts.label && { label: opts.label }),
          ...(opts.includeSuperseded && { include_superseded: "true" }),
        });
        if (opts.json) {
          printJson(res);
          return;
        }
        printTaskTable(res.items);
        if (res.total > res.items.length) {
          console.log(`\n${res.items.length} / ${res.total} (page ${res.page})`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("show <id>")
    .description("Show a single task with metrics, children, and the resolved spec.")
    .option("--json", "Print as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const t = await client.get<TaskRow>(`/tasks/${id}`);
        if (opts.json) {
          printJson(t);
          return;
        }
        console.log(`Task #${t.id} [${t.status}]`);
        console.log(`  type:        ${t.taskType}`);
        console.log(`  agent:       ${t.agent}${t.model ? ` (${t.model})` : ""}`);
        console.log(`  project:     ${t.projectId ?? "(none)"}`);
        if (t.label) console.log(`  label:       ${t.label}`);
        if (t.workingDir) console.log(`  workingDir:  ${t.workingDir}`);
        console.log(`  createdAt:   ${t.createdAt}`);
        if (t.startedAt) console.log(`  startedAt:   ${t.startedAt}`);
        if (t.finishedAt) console.log(`  finishedAt:  ${t.finishedAt}`);
        if (t.parentTaskId) console.log(`  parentTask:  #${t.parentTaskId}`);
        if (t.prompt) {
          console.log(`  prompt:`);
          for (const line of t.prompt.split("\n")) console.log(`    ${line}`);
        } else if (t.promptFile) {
          console.log(`  promptFile:  ${t.promptFile}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("create")
    .description(
      "Create + queue a new task. Either --prompt or --prompt-file must be set. " +
        "If --prompt-file is `-`, read the prompt from stdin.",
    )
    .option("-p, --project <idOrName>", "Target project (required for execution tasks)")
    .option("--prompt <text>", "Inline prompt text")
    .option("--prompt-file <path>", "Read prompt from file. Use `-` for stdin.")
    .option("-a, --agent <agent>", "Agent: claude-code (default) or copilot")
    .option("-m, --model <model>", "Model name override")
    .option("-t, --type <taskType>", "Task type (default: execution)")
    .option("-l, --label <text>", "Free-form label for filtering / grouping")
    .option("--requires-approval", "Hold the result in `awaiting_approval` until manually accepted")
    .option(
      "--permission-mode <mode>",
      "Claude permission mode: default | plan | acceptEdits | bypassPermissions",
    )
    .option("--json", "Print the created row as JSON")
    .action(async (opts: CreateOpts) => {
      try {
        if (!opts.prompt && !opts.promptFile) {
          console.error("Error: pass --prompt or --prompt-file");
          process.exit(1);
        }
        let prompt = opts.prompt;
        if (opts.promptFile) {
          if (opts.promptFile === "-") {
            // Synchronous stdin slurp — fine for a one-shot CLI invocation.
            prompt = readFileSync(0, "utf-8");
          } else {
            prompt = readFileSync(resolvePath(opts.promptFile), "utf-8");
          }
        }
        const client = createDaemonClient();
        const projectId = await resolveProjectId(client, opts.project);
        const body: Record<string, unknown> = {
          prompt,
          ...(projectId !== undefined && { projectId }),
          ...(opts.agent && { agent: opts.agent }),
          ...(opts.model && { model: opts.model }),
          ...(opts.type && { taskType: opts.type }),
          ...(opts.label && { label: opts.label }),
          ...(opts.requiresApproval && { requiresApproval: true }),
          ...(opts.permissionMode && { permissionMode: opts.permissionMode }),
        };
        const created = await client.post<TaskRow>("/tasks", body);
        if (opts.json) {
          printJson(created);
          return;
        }
        console.log(`Created task #${created.id} [${created.status}]`);
        if (created.projectId) console.log(`  project: #${created.projectId}`);
        console.log(`  agent:   ${created.agent}${created.model ? ` (${created.model})` : ""}`);
        console.log(`\nFollow with:\n  flockctl tasks logs ${created.id} -f`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("cancel <id>")
    .description("Cancel a queued or running task.")
    .action(async (id: string) => {
      try {
        const client = createDaemonClient();
        await client.post(`/tasks/${id}/cancel`);
        console.log(`Cancelled task #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("rerun <id>")
    .description("Clone a task's config and queue a fresh run.")
    .option("--json", "Print the new task row as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const created = await client.post<TaskRow>(`/tasks/${id}/rerun`);
        if (opts.json) {
          printJson(created);
          return;
        }
        console.log(`Re-queued as task #${created.id} (parent: #${id})`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("approve <id>")
    .description("Approve a task that is awaiting approval.")
    .option("-n, --note <text>", "Optional reviewer note")
    .action(async (id: string, opts: { note?: string }) => {
      try {
        const client = createDaemonClient();
        await client.post(`/tasks/${id}/approve`, opts.note ? { note: opts.note } : {});
        console.log(`Approved task #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("reject <id>")
    .description("Reject a task awaiting approval (transitions to `cancelled`).")
    .option("-n, --note <text>", "Optional reviewer note")
    .action(async (id: string, opts: { note?: string }) => {
      try {
        const client = createDaemonClient();
        await client.post(`/tasks/${id}/reject`, opts.note ? { note: opts.note } : {});
        console.log(`Rejected task #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("logs <id>")
    .description(
      "Print persisted task logs. With --follow, poll for new lines until the " +
        "task reaches a terminal status. Stdout receives stdout lines; stderr " +
        "receives stderr lines (split by stream_type), so you can pipe normally.",
    )
    .option("-f, --follow", "Stream logs as they arrive (poll-based, 1 s by default)")
    .option("--interval-ms <n>", "Polling interval in milliseconds", "1000")
    .option("-v, --verbose", "Prefix each line with timestamp + stream tag on stderr")
    .action(async (id: string, opts: LogsOpts) => {
      try {
        const client = createDaemonClient();
        const taskId = parseInt(id, 10);
        if (!Number.isFinite(taskId) || taskId <= 0) {
          console.error(`Error: invalid task id "${id}"`);
          process.exit(1);
        }
        if (!opts.follow) {
          const logs = await client.get<{ items: TaskLogRow[] }>(`/tasks/${id}/logs`);
          for (const row of logs.items) {
            const stream = row.stream_type === "stderr" ? process.stderr : process.stdout;
            stream.write(row.content.endsWith("\n") ? row.content : row.content + "\n");
          }
          return;
        }
        await followLogs(client, taskId, opts);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  tasksCmd
    .command("stats")
    .description("Show aggregated task counts by status (and project, if filtered).")
    .option("-p, --project <idOrName>", "Filter to a single project")
    .option("--json", "Print as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const projectId = await resolveProjectId(client, opts.project);
        const stats = await client.get<Record<string, number>>("/tasks/stats", {
          ...(projectId !== undefined && { project_id: projectId }),
        });
        if (opts.json) {
          printJson(stats);
          return;
        }
        const keyW = Math.max(...Object.keys(stats).map((k) => k.length));
        for (const [k, v] of Object.entries(stats)) {
          console.log(`  ${k.padEnd(keyW)}  ${v}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
