import type { Hono } from "hono";
import { z } from "zod";
import { createReadStream, existsSync } from "fs";
import { Readable } from "stream";
import { getDb } from "../../db/index.js";
import { chats, chatAttachments } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import {
  saveAttachment,
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
} from "../../services/attachments.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

// ─── Attachments ────────────────────────────────────────────────────────────
// Single-param routes (`:id`) go through `parseIdParam(c)`; the two-param
// `:id/:attId` shape still uses zod because we want a single failure envelope
// across both segments.
export const attachmentBlobParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  attId: z.coerce.number().int().positive(),
});

export function registerChatAttachments(router: Hono): void {
  // POST /chats/:id/attachments — upload an image blob. Accepts multipart with
  // a single `file` part. Magic-byte sniff + size gate + MIME mismatch checks
  // all live in the service; the handler only translates AttachmentError →
  // 422 and shape-checks the multipart envelope.
  router.post("/:id/attachments", async (c) => {
    const chatId = parseIdParam(c);
    getChatOrThrow(chatId);

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw new ValidationError("invalid multipart body");
    }

    const uploaded = body.file;
    if (!(uploaded instanceof File)) {
      throw new ValidationError("file field is required");
    }

    const ab = await uploaded.arrayBuffer();
    const bytes = Buffer.from(ab);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      // Early reject — no disk write attempted.
      throw new ValidationError(
        `file exceeds ${MAX_ATTACHMENT_BYTES} bytes (got ${bytes.length})`,
      );
    }

    try {
      const row = saveAttachment({
        chatId,
        file: {
          bytes,
          filename: uploaded.name,
          mimeType: uploaded.type,
        },
      });
      return c.json(row, 201);
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
  });

  // GET /chats/:id/attachments/:attId/blob — stream the on-disk image for an
  // attachment. The handler double-checks that the row exists AND belongs to
  // `:id` (no cross-chat exfiltration via a guessed attachment id) and that the
  // blob is still on disk before opening a read stream. We stream via
  // `fs.createReadStream` → `Readable.toWeb` rather than slurping the file into
  // memory so a 10 MB upload doesn't balloon Node's resident set on every
  // thumbnail fetch.
  //
  // `Content-Disposition: inline` lets the browser render the image directly;
  // `X-Content-Type-Options: nosniff` keeps a mislabelled blob from being
  // rendered as HTML/JS by a browser that tries to sniff harder than we do.
  router.get("/:id/attachments/:attId/blob", (c) => {
    const parsed = attachmentBlobParamsSchema.safeParse({
      id: c.req.param("id"),
      attId: c.req.param("attId"),
    });
    if (!parsed.success) throw new NotFoundError("Attachment");
    const { id: chatId, attId } = parsed.data;

    const db = getDb();
    const row = db
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.id, attId))
      .get();
    // A missing row, a row that belongs to a different chat, or a row whose
    // on-disk blob has been swept/deleted all collapse to the same 404 —
    // indistinguishable so callers can't probe existence across chat scopes.
    if (!row || row.chatId !== chatId) throw new NotFoundError("Attachment");
    if (!existsSync(row.path)) throw new NotFoundError("Attachment");

    // ETag = attachment id. Attachments are content-addressed (UUID-named
    // and immutable after upload), so the id IS a strong validator for the
    // bytes — no need to hash the file contents.
    const etag = `"${attId}"`;
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      // 304 Not Modified — saves re-streaming the file on transcript
      // rerender / scrollback. Headers mirror the 200 path so a cache
      // primed with the previous response stays valid.
      return c.body(null, 304, {
        ETag: etag,
        "Cache-Control": "private, max-age=3600, immutable",
      });
    }

    const nodeStream = createReadStream(row.path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    // Encode the display filename for the `filename*` parameter. Using the
    // RFC 5987 `UTF-8''…` form so non-ASCII filenames (e.g. cyrillic) round-trip
    // cleanly; `encodeURIComponent` escapes every reserved token for us.
    const safeName = encodeURIComponent(row.filename);
    return c.body(webStream, 200, {
      "Content-Type": row.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(row.sizeBytes),
      "Content-Disposition": `inline; filename*=UTF-8''${safeName}`,
      // Blobs are immutable once uploaded (the UUID filename is regenerated
      // on every upload). `immutable` tells modern browsers never to
      // revalidate within the freshness window, eliminating the 304
      // round-trip on chat scrollback entirely; the ETag above is the
      // fallback for cache-busting fetchers that ignore `immutable`.
      "Cache-Control": "private, max-age=3600, immutable",
      ETag: etag,
    });
  });
}
