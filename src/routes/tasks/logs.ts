import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { tasks, taskLogs } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { NotFoundError } from "../../lib/errors.js";
import { parseIdParam, parseBoundedIntQuery } from "../../lib/route-params.js";
import { paginationParams } from "../../lib/pagination.js";
import { getTaskOrThrow } from "../../lib/db-helpers.js";
import {
  parseJournal,
  renderJournalAsUnifiedDiff,
  summarizeJournal,
} from "../../services/file-edit-journal.js";

/**
 * Pagination knobs for `GET /tasks/:id/logs`. Logs are append-only and
 * unbounded — a long-running task can accumulate tens of thousands of rows.
 * Without this cap a single GET could pull the whole table into memory and
 * stringify it for the JSON response (audit-round-2 finding C4: DoS surface).
 *
 * Both the default and the cap are larger than the global 20/100 pagination
 * defaults because a typical task-log scrubber wants to render hundreds of
 * lines at once. Clients that need more pages walk with `?offset=`.
 */
const TASK_LOGS_PAGINATION_OPTS = { defaultPerPage: 1000, maxPerPage: 5000 } as const;

export function registerTaskLogs(router: Hono): void {
  // GET /tasks/:id/logs?limit=&offset=
  //
  // Returns a chronologically-ordered slice of log rows, capped at
  // `TASK_LOGS_MAX_LIMIT` per call. The response carries `total` so the UI
  // can render "showing N of M" and "load more" affordances without having
  // to issue a HEAD-like probe.
  router.get("/:id/logs", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    getTaskOrThrow(id);

    const { perPage: limit, offset } = paginationParams(c, TASK_LOGS_PAGINATION_OPTS);

    const rows = db
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .orderBy(taskLogs.timestamp)
      .limit(limit)
      .offset(offset)
      .all();
    const totalRow = db
      .select({ count: sql<number>`count(*)` })
      .from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .get();
    /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
    const total = totalRow?.count ?? 0;
    const logs = rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.taskId),
      content: r.content,
      stream_type: r.streamType,
      timestamp: r.timestamp,
    }));
    // Backward-compatible: legacy clients that ignore the wrapper see the
    // bare array shape; new clients can opt into the paginated wrapper via
    // `?paginated=true` (returns `{ items, total, limit, offset }`).
    if (c.req.query("paginated") === "true") {
      return c.json({ items: logs, total, limit, offset });
    }
    return c.json(logs);
  });
}

/**
 * `GET /tasks/:id/diff` — synthesized unified diff covering every
 * Edit/Write/MultiEdit tool call the agent made in this task. The diff is
 * built from the in-DB `file_edits` journal (see migration 0036 and
 * `services/file-edit-journal.ts`) rather than `git diff` of the shared
 * working tree, so concurrent tasks running in the same project do not
 * cross-contaminate and pre-existing working-tree dirt does not leak in.
 *
 * Response shape is stable across tasks and chats — `GET /chats/:id/diff`
 * returns the same payload keyed by chat id.
 */
export function registerTaskDiff(router: Hono): void {
  router.get("/:id/diff", (c) => {
    const id = parseIdParam(c);
    const task = getTaskOrThrow(id);

    const maxLines = parseBoundedIntQuery(c, "maxLines", { min: 1, max: 200_000, default: 2000 });
    const journal = parseJournal(task.fileEdits);
    const summary = summarizeJournal(journal);
    let diff = renderJournalAsUnifiedDiff(journal);

    const lines = diff.split("\n");
    const truncated = lines.length > maxLines;
    if (truncated) diff = lines.slice(0, maxLines).join("\n");

    return c.json({
      summary: summary?.text ?? task.gitDiffSummary ?? null,
      diff,
      truncated,
      total_lines: lines.length,
      total_files: summary?.files ?? 0,
      total_entries: journal.entries.length,
    });
  });
}
