/**
 * `flockctl metrics` and `flockctl usage` — read-only analytics.
 *
 * `metrics overview`     → /metrics/overview
 * `usage summary`        → /usage/summary
 * `usage breakdown`      → /usage/breakdown
 * `usage records`        → /usage/records
 * `usage budgets`        → /usage/budgets
 *
 * All accept `--from / --to / --period / --key-id / --group-by` flags
 * mirroring the API's query string. Default rendering is a compact
 * table; `--json` emits the raw payload for piping into `jq`.
 */
import type { Command } from "commander";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { printJson } from "./_shared.js";

interface DateRangeOpts {
  from?: string;
  to?: string;
  period?: string;
  keyId?: string;
  json?: boolean;
}

function buildQuery(opts: DateRangeOpts & { groupBy?: string }): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  if (opts.from) q.date_from = opts.from;
  if (opts.to) q.date_to = opts.to;
  if (opts.period) q.period = opts.period;
  if (opts.keyId) q.ai_provider_key_id = opts.keyId;
  if (opts.groupBy) q.group_by = opts.groupBy;
  return q;
}

function attachDateFlags(c: ReturnType<Command["command"]>): ReturnType<Command["command"]> {
  return c
    .option("--from <date>", "ISO date (inclusive lower bound)")
    .option("--to <date>", "ISO date (exclusive upper bound)")
    .option("--period <p>", "Relative period (e.g. 1d, 7d, 30d)")
    .option("--key-id <id>", "Scope to a single AI provider key id");
}

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

export function registerMetricsCommand(program: Command): void {
  const cmd = program.command("metrics").description("Daemon analytics: tasks, queue, cost.");

  attachDateFlags(
    cmd
      .command("overview")
      .description("Aggregated task / chat / cost overview.")
      .option("--json", "Print as JSON"),
  ).action(async (opts: DateRangeOpts) => {
    try {
      const client = createDaemonClient();
      const res = await client.get<Record<string, unknown>>("/metrics/overview", buildQuery(opts));
      if (opts.json) {
        printJson(res);
        return;
      }
      const rows: [string, unknown][] = Object.entries(res).filter(
        ([_, v]) => v === null || typeof v !== "object",
      );
      const labelW = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) {
        console.log(`  ${pad(k, labelW)}  ${v ?? "(null)"}`);
      }
    } catch (err) {
      exitWithDaemonError(err);
    }
  });
}

export function registerUsageCommand(program: Command): void {
  const cmd = program
    .command("usage")
    .description("Token + cost breakdown by provider/model/project/day.");

  attachDateFlags(
    cmd
      .command("summary")
      .description("Global token + cost summary.")
      .option("--json", "Print as JSON"),
  ).action(async (opts: DateRangeOpts) => {
    try {
      const client = createDaemonClient();
      const res = await client.get<Record<string, unknown>>("/usage/summary", buildQuery(opts));
      if (opts.json) {
        printJson(res);
        return;
      }
      for (const [k, v] of Object.entries(res)) {
        if (v === null || typeof v !== "object") {
          console.log(`  ${k}: ${v ?? "(null)"}`);
        }
      }
    } catch (err) {
      exitWithDaemonError(err);
    }
  });

  attachDateFlags(
    cmd
      .command("breakdown")
      .description("Paginated breakdown by provider / model / project / day.")
      .option("--group-by <dim>", "provider | model | project | day", "model")
      .option("--page <n>", "1-based page", "1")
      .option("--per-page <n>", "Page size", "100")
      .option("--json", "Print as JSON"),
  ).action(
    async (
      opts: DateRangeOpts & { groupBy?: string; page?: string; perPage?: string },
    ) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<{ items: Record<string, unknown>[] } & Record<string, unknown>>(
          "/usage/breakdown",
          {
            ...buildQuery(opts),
            page: opts.page ?? "1",
            perPage: opts.perPage ?? "100",
          },
        );
        if (opts.json) {
          printJson(res);
          return;
        }
        for (const row of res.items) {
          console.log(`  ${JSON.stringify(row)}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    },
  );

  attachDateFlags(
    cmd
      .command("records")
      .description("Raw usage records (paginated).")
      .option("--group-by <dim>", "Optional grouping (provider | model | project | day)")
      .option("--page <n>", "1-based page", "1")
      .option("--per-page <n>", "Page size", "100")
      .option("--json", "Print as JSON"),
  ).action(
    async (
      opts: DateRangeOpts & { groupBy?: string; page?: string; perPage?: string },
    ) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<{ items: unknown[] }>("/usage/records", {
          ...buildQuery(opts),
          page: opts.page ?? "1",
          perPage: opts.perPage ?? "100",
        });
        if (opts.json) {
          printJson(res);
          return;
        }
        for (const r of res.items) console.log(`  ${JSON.stringify(r)}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    },
  );

  cmd
    .command("budgets")
    .description("Show configured budgets + current spend.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<{ items: unknown[] }>("/usage/budgets");
        if (opts.json) {
          printJson(res);
          return;
        }
        for (const b of res.items) console.log(`  ${JSON.stringify(b)}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
