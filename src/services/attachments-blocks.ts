import { readFileSync } from "fs";
import type {
  Base64ImageSource,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources";
import { MAX_INLINE_TEXT_BYTES, type AttachmentRow } from "./attachments-types.js";

// ─── Base64 cache for immutable attachments ─────────────────────────────
//
// Every chat turn re-reads + base64-encodes every attachment from disk.
// Attachments are content-addressed (UUID-named in the FS) and immutable —
// the same path always yields the same bytes — so caching by path is safe.
//
// Without this cache, a user resending a chat turn with the same 5 MB image
// pays O(n) read + O(n) base64-encode on every send. With cache, only the
// first send pays the cost; subsequent reuses are O(1).
//
// Bounded by total cached bytes (not entry count). Eviction is LRU: when
// adding would push past the cap, drop oldest entries first. Map iteration
// order is insertion order in JS, so a delete-then-set "refreshes" an
// entry's LRU position.
const BASE64_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB
const base64Cache = new Map<string, string>();
let base64CacheBytes = 0;

function readBase64Cached(path: string): string | null {
  const cached = base64Cache.get(path);
  if (cached !== undefined) {
    // Refresh LRU position.
    base64Cache.delete(path);
    base64Cache.set(path, cached);
    return cached;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    console.warn(`[attachments] failed to read ${path}:`, err);
    return null;
  }
  const encoded = bytes.toString("base64");
  // Evict oldest until adding `encoded` fits within the cap.
  while (
    base64CacheBytes + encoded.length > BASE64_CACHE_MAX_TOTAL_BYTES &&
    base64Cache.size > 0
  ) {
    const oldestKey = base64Cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestValue = base64Cache.get(oldestKey)!;
    base64CacheBytes -= oldestValue.length;
    base64Cache.delete(oldestKey);
  }
  // Special-case: if this single attachment is larger than the cap, don't
  // cache it (would evict everything else, then itself on the next miss).
  if (encoded.length <= BASE64_CACHE_MAX_TOTAL_BYTES) {
    base64Cache.set(path, encoded);
    base64CacheBytes += encoded.length;
  }
  return encoded;
}

/** @internal — test seam. */
export function __resetBase64Cache(): void {
  base64Cache.clear();
  base64CacheBytes = 0;
}

/**
 * MIME types supported by Anthropic's image content block. GIFs are sent as
 * whole files — we don't extract the first frame. Anthropic accepts GIF
 * natively (they decode it server-side), but the model only "sees" one
 * representative frame. Documenting the limitation rather than pulling in
 * `sharp` just to re-encode keeps the dependency surface minimal.
 */
type AnthropicImageMime = Base64ImageSource["media_type"];
export const ANTHROPIC_IMAGE_MIME_TYPES = new Set<AnthropicImageMime>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Turn one attachment row into an Anthropic `image` content block. Reads the
 * file from disk, base64-encodes it, and packages it in the SDK's native
 * block shape — no parallel "multimodal" type, the Anthropic SDK accepts
 * this directly. Returns null if the on-disk blob is missing (best-effort —
 * we don't want a transient FS hiccup to crash the whole request) or the
 * MIME isn't in the Anthropic-supported set.
 */
export function attachmentToImageBlock(
  row: Pick<AttachmentRow, "path" | "mimeType">,
): ImageBlockParam | null {
  const mime = row.mimeType as AnthropicImageMime;
  if (!ANTHROPIC_IMAGE_MIME_TYPES.has(mime)) {
    return null;
  }
  const data = readBase64Cached(row.path);
  if (data === null) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mime,
      data,
    },
  };
}

/**
 * Turn one PDF attachment into an Anthropic `document` block using the
 * Base64PDFSource shape. Returns null if the row isn't a PDF or the on-disk
 * blob vanished. The `title` hint echoes the original filename so the model
 * has a useful reference when quoting content back to the user.
 */
export function attachmentToPdfDocumentBlock(
  row: Pick<AttachmentRow, "path" | "mimeType" | "filename">,
): DocumentBlockParam | null {
  if (row.mimeType !== "application/pdf") return null;
  const data = readBase64Cached(row.path);
  if (data === null) return null;
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data,
    },
    title: row.filename,
  };
}

/** MIME prefixes that map onto Anthropic's PlainTextSource. Anything else
 *  we deliberately don't emit as a text document block. */
export function isTextLikeMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/xml" ||
    mime === "application/json" ||
    mime === "application/sql"
  );
}

/**
 * Turn a text-like attachment (XML/CSV/JSON/MD/source/plain) into an
 * Anthropic `document` block backed by a PlainTextSource. The model sees
 * the decoded file contents as a first-class document rather than an inline
 * string, which keeps the user's prompt cleanly separated from the
 * attachment body. Returns null on unreadable files or MIME mismatch.
 */
export function attachmentToTextDocumentBlock(
  row: Pick<AttachmentRow, "path" | "mimeType" | "filename">,
): DocumentBlockParam | null {
  if (!isTextLikeMime(row.mimeType)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(row.path);
  } catch (err) {
    console.warn(`[attachments] failed to read ${row.path}:`, err);
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    console.warn(`[attachments] ${row.path} is not valid UTF-8 — skipping`);
    return null;
  }
  if (text.length > MAX_INLINE_TEXT_BYTES) {
    // Truncate and tag the document so the model knows the body is partial.
    // 1 MB of text is already ~250k tokens; sending more would blow context
    // before the model gets to the user's actual question.
    text = text.slice(0, MAX_INLINE_TEXT_BYTES) +
      `\n\n[truncated — original file was ${bytes.length} bytes]`;
  }
  return {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: text,
    },
    title: row.filename,
  };
}

/**
 * Build the Anthropic `MessageParam.content` for one chat turn. When a
 * message has no linked attachments, returns the plain text string — this
 * keeps the text-only path byte-identical to pre-multimodal behavior.
 *
 * With attachments, returns a content-block array that puts the user's
 * prose first, followed by one block per attachment in caller order. Each
 * attachment row is classified by MIME:
 *   - images (PNG/JPEG/GIF/WEBP) → `image` block
 *   - PDF                        → `document` block (Base64PDFSource)
 *   - text-like (XML/CSV/JSON/…) → `document` block (PlainTextSource)
 *   - unknown                    → silently skipped (the original upload
 *     gate should have rejected these already)
 *
 * Empty / missing attachments collapse back to the string return so callers
 * don't need a branch.
 */
export function buildMessageContent(
  text: string,
  attachments:
    | readonly Pick<AttachmentRow, "path" | "mimeType" | "filename">[]
    | undefined,
): string | ContentBlockParam[] {
  if (!attachments || attachments.length === 0) return text;
  const attachmentBlocks: ContentBlockParam[] = [];
  for (const att of attachments) {
    if (ANTHROPIC_IMAGE_MIME_TYPES.has(att.mimeType as AnthropicImageMime)) {
      const block = attachmentToImageBlock(att);
      if (block) attachmentBlocks.push(block);
      continue;
    }
    if (att.mimeType === "application/pdf") {
      const block = attachmentToPdfDocumentBlock(att);
      if (block) attachmentBlocks.push(block);
      continue;
    }
    if (isTextLikeMime(att.mimeType)) {
      const block = attachmentToTextDocumentBlock(att);
      if (block) attachmentBlocks.push(block);
      continue;
    }
    console.warn(
      `[attachments] skipping ${att.path}: unsupported MIME for content block (${att.mimeType})`,
    );
  }
  if (attachmentBlocks.length === 0) return text;
  return [{ type: "text", text }, ...attachmentBlocks];
}
