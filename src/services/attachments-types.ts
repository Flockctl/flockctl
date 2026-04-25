import type { chatAttachments } from "../db/schema.js";

export type AttachmentRow = typeof chatAttachments.$inferSelect;

export interface SaveAttachmentInput {
  chatId: number;
  file: {
    /** Raw upload bytes. */
    bytes: Buffer;
    /** Client-declared filename (display-only; sanitized before storage). */
    filename: string;
    /** Client-declared MIME. Must match the sniffed MIME exactly. */
    mimeType: string;
  };
  /** Optional linked message id. */
  messageId?: number | null;
}

export class AttachmentError extends Error {
  constructor(
    message: string,
    public code: "mime_mismatch" | "unsupported" | "too_large" | "empty",
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

// Per-file and per-message caps tuned to match Claude Code's practical
// attachment limits:
//   - 30 MB per file: the same ceiling Claude Code advertises and enough for
//     the 32 MB PDF cap on Anthropic's inline multimodal path.
//   - 30 MB total per message: Anthropic rejects requests larger than ~32 MB
//     (after base64 overhead); keeping the aggregate at 30 MB keeps a single
//     big PDF + a text file safely under that cap.
//   - 10 attachments per message: unchanged — matches the composer UX and
//     gives room for screenshots without letting a user stitch 100 files
//     into a single request.
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024; // 30 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB

// How big a text attachment may be before we refuse to inline its full
// contents into a PlainTextSource document block. Anything under this goes
// straight into the model context; over it and we still store the blob, but
// the content block truncates the body and tells the model how to fetch the
// rest via the blob URL. 1 MB is already a wall of text (~250k tokens) and
// is comfortably below the 32 MB Anthropic request cap even with base64
// overhead.
export const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB
