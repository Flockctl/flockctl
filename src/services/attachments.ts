import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { chatAttachments } from "../db/schema.js";
import { sanitizeFilename, sniffAttachmentType } from "./attachments-sniff.js";
import { getChatAttachmentsDir } from "./attachments-storage.js";
import {
  AttachmentError,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
  type AttachmentRow,
  type SaveAttachmentInput,
} from "./attachments-types.js";

// ─── Re-exports — preserve the public API surface every caller imports from
// `services/attachments.js`. Factored sub-modules are implementation details.
export {
  sniffImageType,
  sniffAttachmentType,
  sanitizeFilename,
  type AttachmentKind,
  type SniffResult,
} from "./attachments-sniff.js";
export {
  getAttachmentsRoot,
  deleteAttachmentFiles,
  sweepOrphans,
} from "./attachments-storage.js";
export {
  ANTHROPIC_IMAGE_MIME_TYPES,
  attachmentToImageBlock,
  attachmentToPdfDocumentBlock,
  attachmentToTextDocumentBlock,
  buildMessageContent,
  isTextLikeMime,
} from "./attachments-blocks.js";
export {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
  MAX_INLINE_TEXT_BYTES,
  type AttachmentRow,
  type SaveAttachmentInput,
} from "./attachments-types.js";

/** Known image MIME tokens the client may send. Used to lock down the
 *  anti-spoofing check — if the client explicitly declares one of these but
 *  the content is not the matching image, we refuse the upload rather than
 *  silently reclassifying it as text. */
const IMAGE_CLIENT_MIMES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Persist an uploaded file under `~/flockctl/attachments/{chatId}/{uuid}.{ext}`
 * and insert a `chat_attachments` row. Accepts images (PNG/JPEG/GIF/WEBP),
 * PDFs, and text-like content (XML, CSV, JSON, Markdown, source code, plain
 * text). Throws AttachmentError on validation failure; the caller should map
 * that to an HTTP 422.
 *
 * Anti-spoofing rule: if the client explicitly declared an image or PDF MIME
 * but the sniff disagrees, the upload is rejected — that's the "malicious
 * blob labelled as a picture" case. For any other client MIME (or no MIME
 * at all) we trust our own sniff, because browsers routinely send vague or
 * wrong types for .csv, .xml, and .json files.
 */
export function saveAttachment(input: SaveAttachmentInput): AttachmentRow {
  const { chatId, file, messageId } = input;

  if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length === 0) {
    throw new AttachmentError("file is empty", "empty");
  }

  // (1) size gate first — skip sniffing on oversize blobs
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `file exceeds ${MAX_ATTACHMENT_BYTES} bytes (got ${file.bytes.length})`,
      "too_large",
    );
  }

  // (2) unified sniff → kind + canonical MIME + extension
  const sniffed = sniffAttachmentType(file.bytes, file.filename);
  if (!sniffed) {
    throw new AttachmentError(
      "unsupported file type (allowed: images, PDF, or text-based files like XML, CSV, JSON, Markdown, code)",
      "unsupported",
    );
  }

  // (3) anti-spoofing: client claimed image/* but bytes aren't an image
  const clientMime = (file.mimeType ?? "").toLowerCase().trim();
  if (IMAGE_CLIENT_MIMES.has(clientMime) && sniffed.kind !== "image") {
    throw new AttachmentError(
      `declared MIME ${clientMime} does not match sniffed ${sniffed.mime}`,
      "mime_mismatch",
    );
  }
  // Same guard for PDF — client said PDF, content disagrees.
  if (clientMime === "application/pdf" && sniffed.kind !== "pdf") {
    throw new AttachmentError(
      `declared MIME ${clientMime} does not match sniffed ${sniffed.mime}`,
      "mime_mismatch",
    );
  }
  // If client declared a specific image MIME but content is a DIFFERENT image
  // format (e.g. PNG bytes sent as "image/jpeg"), reject — the canonical
  // rendering path picks the MIME we advertise back to the browser, and
  // mismatched ones confuse thumbnail handling.
  if (
    IMAGE_CLIENT_MIMES.has(clientMime) &&
    sniffed.kind === "image" &&
    clientMime !== sniffed.mime &&
    // jpg/jpeg aliases don't count as a mismatch
    !(clientMime === "image/jpg" && sniffed.mime === "image/jpeg")
  ) {
    throw new AttachmentError(
      `declared MIME ${clientMime} does not match sniffed ${sniffed.mime}`,
      "mime_mismatch",
    );
  }

  // (4) UUID filename with sniffed extension
  const uuid = randomUUID();
  const storageName = `${uuid}.${sniffed.ext}`;

  // (5) write under ~/flockctl/attachments/{chatId}/{uuid}.{ext}
  const chatDir = getChatAttachmentsDir(chatId);
  mkdirSync(chatDir, { recursive: true });
  const path = join(chatDir, storageName);
  writeFileSync(path, file.bytes);

  // (6) insert DB row
  const db = getDb();
  const row = db
    .insert(chatAttachments)
    .values({
      chatId,
      messageId: messageId ?? null,
      filename: sanitizeFilename(file.filename),
      mimeType: sniffed.mime,
      sizeBytes: file.bytes.length,
      path,
    })
    .returning()
    .get();

  // (7) return the row
  return row;
}

/**
 * Load all attachment rows belonging to a chat — used by DELETE /chats/:id to
 * enumerate files to unlink before SQLite cascades the rows away.
 */
export function listAttachmentsForChat(chatId: number): AttachmentRow[] {
  const db = getDb();
  return db.select().from(chatAttachments).where(eq(chatAttachments.chatId, chatId)).all();
}

/**
 * Validate a list of attachment ids before linking them to a new chat message.
 *
 * Every id must:
 *   - exist in chat_attachments,
 *   - belong to the supplied chatId (no cross-chat theft), AND
 *   - have message_id == NULL (not already linked to a prior message).
 *
 * Additional caps enforced:
 *   - count ≤ MAX_ATTACHMENTS_PER_MESSAGE
 *   - sum(size_bytes) ≤ MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES
 *
 * Duplicate ids in the input are collapsed before the ownership / link check so
 * a caller that accidentally sends `[7, 7]` still gets a deterministic
 * outcome instead of a false "count mismatch". Throws AttachmentError on
 * failure — the route handler is expected to translate that into a 422.
 */
export function validateAttachmentsForMessage(
  chatId: number,
  attachmentIds: readonly number[],
): AttachmentRow[] {
  if (attachmentIds.length === 0) return [];

  if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(
      `too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE}, got ${attachmentIds.length})`,
      "too_large",
    );
  }

  const uniqueIds = Array.from(new Set(attachmentIds));
  const db = getDb();
  const rows = db
    .select()
    .from(chatAttachments)
    .where(inArray(chatAttachments.id, uniqueIds))
    .all();

  if (rows.length !== uniqueIds.length) {
    throw new AttachmentError(
      "one or more attachment ids do not exist",
      "unsupported",
    );
  }

  for (const r of rows) {
    if (r.chatId !== chatId) {
      throw new AttachmentError(
        `attachment ${r.id} does not belong to chat ${chatId}`,
        "unsupported",
      );
    }
    if (r.messageId !== null) {
      throw new AttachmentError(
        `attachment ${r.id} is already linked to message ${r.messageId}`,
        "unsupported",
      );
    }
  }

  const totalBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
  if (totalBytes > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES) {
    throw new AttachmentError(
      `total attachment size ${totalBytes} exceeds ${MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES} bytes`,
      "too_large",
    );
  }

  // Preserve caller order in the returned rows so the API response mirrors the
  // client-supplied attachment_ids array. Drizzle's `inArray` is order-agnostic
  // on the wire.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uniqueIds.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Fetch every linked attachment for a list of message ids in one query, then
 * return a `Map<messageId, AttachmentRow[]>` for O(1) lookup while building
 * content blocks. Empty message ids → empty map.
 */
export function loadAttachmentsForMessages(
  messageIds: readonly number[],
): Map<number, AttachmentRow[]> {
  const out = new Map<number, AttachmentRow[]>();
  if (messageIds.length === 0) return out;
  const db = getDb();
  const rows = db
    .select()
    .from(chatAttachments)
    .where(inArray(chatAttachments.messageId, Array.from(new Set(messageIds))))
    .all();
  for (const r of rows) {
    /* v8 ignore next — the WHERE clause is `messageId IN (non-null ids)`, so
       every returned row has a non-null messageId; this is defensive only. */
    if (r.messageId == null) continue;
    const list = out.get(r.messageId) ?? [];
    list.push(r);
    out.set(r.messageId, list);
  }
  return out;
}

/**
 * UPDATE chat_attachments SET message_id = ? WHERE id IN (...). Returns the
 * freshly updated rows so the caller can echo them in the API response without
 * a second round-trip. No-op on empty input.
 */
export function linkAttachmentsToMessage(
  messageId: number,
  attachmentIds: readonly number[],
): AttachmentRow[] {
  if (attachmentIds.length === 0) return [];
  const uniqueIds = Array.from(new Set(attachmentIds));
  const db = getDb();
  db.update(chatAttachments)
    .set({ messageId })
    .where(inArray(chatAttachments.id, uniqueIds))
    .run();
  const rows = db
    .select()
    .from(chatAttachments)
    .where(inArray(chatAttachments.id, uniqueIds))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uniqueIds.map((id) => byId.get(id)!).filter(Boolean);
}
