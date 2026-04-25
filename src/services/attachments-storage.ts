import {
  existsSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { getDb } from "../db/index.js";
import { chatAttachments } from "../db/schema.js";
import { getFlockctlHome } from "../config/index.js";
import type { AttachmentRow } from "./attachments-types.js";

/** Root directory for all attachment blobs. */
export function getAttachmentsRoot(): string {
  return join(getFlockctlHome(), "attachments");
}

/** Per-chat directory inside the attachments root. */
export function getChatAttachmentsDir(chatId: number): string {
  return join(getAttachmentsRoot(), String(chatId));
}

/**
 * Best-effort unlink each attachment blob on disk. Missing files are logged at
 * warn level — they're the common case on a cascade delete right after a
 * manual disk wipe. Any other error is logged and swallowed so DB cascade can
 * proceed even if the filesystem is read-only.
 */
export function deleteAttachmentFiles(
  rows: Array<Pick<AttachmentRow, "id" | "path">>,
): void {
  for (const row of rows) {
    try {
      unlinkSync(row.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        console.warn(`[attachments] file already gone: ${row.path}`);
      } else {
        console.warn(`[attachments] failed to unlink ${row.path}:`, err);
      }
    }
  }

  // Collapse now-empty per-chat dirs — nice-to-have cleanup. Best effort.
  const chatIds = new Set<string>();
  for (const row of rows) {
    chatIds.add(dirname(row.path));
  }
  for (const dir of chatIds) {
    try {
      rmdirSync(dir);
    } catch {
      /* directory not empty or already gone — ignore */
    }
  }
}

/**
 * Scan `~/flockctl/attachments/*` and remove any file whose absolute path is
 * NOT present in `chat_attachments.path`. Called at boot before the server
 * listens. Logs counts and never throws — the caller swallows errors.
 */
export function sweepOrphans(): { scanned: number; removed: number } {
  const root = getAttachmentsRoot();
  if (!existsSync(root)) return { scanned: 0, removed: 0 };

  // Collect every tracked absolute path in one query — fast, fits in memory
  // even for large chats (tens of thousands of rows).
  const db = getDb();
  const known = new Set<string>();
  const rows = db.select({ path: chatAttachments.path }).from(chatAttachments).all();
  for (const r of rows) known.add(resolve(r.path));

  let scanned = 0;
  let removed = 0;

  const chatDirs = readdirSync(root, { withFileTypes: true });
  for (const entry of chatDirs) {
    if (!entry.isDirectory()) continue;
    const chatDir = join(root, entry.name);
    let files: string[];
    try {
      files = readdirSync(chatDir);
    } catch {
      continue;
    }
    for (const name of files) {
      const full = resolve(join(chatDir, name));
      scanned++;
      if (known.has(full)) continue;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        unlinkSync(full);
        removed++;
      } catch (err) {
        console.warn(`[attachments] sweep failed to unlink ${full}:`, err);
      }
    }
    // If the chat dir is now empty, drop it too.
    try {
      const remaining = readdirSync(chatDir);
      if (remaining.length === 0) rmdirSync(chatDir);
    } catch {
      /* ignore */
    }
  }

  return { scanned, removed };
}
