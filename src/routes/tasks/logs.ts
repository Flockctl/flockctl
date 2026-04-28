import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { tasks, taskLogs } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { getTaskOrThrow } from "../../lib/db-helpers.js";
import {
  parseJournal,
  renderJournalAsUnifiedDiff,
  summarizeJournal,
} from "../../services/file-edit-journal.js";

export function registerTaskLogs(router: Hono): void {
  // GET /tasks/:id/logs
  router.get("/:id/logs", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    getTaskOrThrow(id);

    const rows = db.select().from(taskLogs).where(eq(taskLogs.taskId, id)).orderBy(taskLogs.timestamp).all();
    const logs = rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.taskId),
      content: r.content,
      stream_type: r.streamType,
      timestamp: r.timestamp,
    }));
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

    const maxLines = parseInt(c.req.query("maxLines") ?? "2000") || 2000;
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
