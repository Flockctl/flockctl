import type { Hono } from "hono";
import { parseIdParam } from "../../lib/route-params.js";
import {
  parseJournal,
  renderJournalAsUnifiedDiff,
  summarizeJournal,
} from "../../services/file-edit-journal.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

/**
 * `GET /chats/:id/diff` — synthesized unified diff covering every
 * Edit/Write/MultiEdit tool call made over the entire lifetime of this
 * chat. The payload mirrors `GET /tasks/:id/diff` so the frontend can use
 * the same `<InlineDiff>` renderer for both.
 *
 * The diff is built from the chat's `file_edits` journal (populated in
 * chat-executor.ts) rather than `git diff` of the shared working tree —
 * this keeps the chat's diff isolated from parallel chats / tasks running
 * in the same project. See `services/file-edit-journal.ts` for the
 * design rationale.
 */
export function registerChatDiff(router: Hono): void {
  router.get("/:id/diff", (c) => {
    const id = parseIdParam(c);
    const chat = getChatOrThrow(id);

    const maxLines = parseInt(c.req.query("maxLines") ?? "2000") || 2000;
    const journal = parseJournal(chat.fileEdits);
    const summary = summarizeJournal(journal);
    let diff = renderJournalAsUnifiedDiff(journal);

    const lines = diff.split("\n");
    const truncated = lines.length > maxLines;
    if (truncated) diff = lines.slice(0, maxLines).join("\n");

    return c.json({
      summary: summary?.text ?? null,
      diff,
      truncated,
      total_lines: lines.length,
      total_files: summary?.files ?? 0,
      total_entries: journal.entries.length,
    });
  });
}
