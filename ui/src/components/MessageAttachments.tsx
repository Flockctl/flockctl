import { memo, useEffect, useState, useCallback } from "react";
import { X } from "lucide-react";
import { getApiBaseUrl } from "@/lib/api";
import type { ChatMessageAttachment } from "@/lib/types";

interface MessageAttachmentsProps {
  /** Owning chat id — used to build the scoped blob URL. */
  chatId: string;
  attachments: ChatMessageAttachment[];
}

/**
 * Build the URL for one attachment's blob endpoint. Tied to the chat route so
 * the server can enforce cross-chat isolation (an attachment from chat A
 * cannot be served from chat B's namespace).
 */
function attachmentBlobUrl(chatId: string, attachmentId: string): string {
  return `${getApiBaseUrl()}/chats/${chatId}/attachments/${attachmentId}/blob`;
}

/**
 * Render one user message's linked attachments as a grid of thumbnails.
 * Clicking a thumbnail opens a small local lightbox — a fullscreen overlay
 * with the full-size image, an Escape / click-outside to close, and nothing
 * else. We keep the lightbox in-tree (no external dep) because the surface is
 * tiny: open/close state, one <img>, a dismiss button. A third-party lightbox
 * would pull in orders of magnitude more JS for the same two interactions.
 */
export const MessageAttachments = memo(function MessageAttachments({ chatId, attachments }: MessageAttachmentsProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeAttachment =
    activeId !== null ? attachments.find((a) => a.id === activeId) ?? null : null;

  const closeLightbox = useCallback(() => setActiveId(null), []);

  // Escape closes the lightbox — a minimum-viable keyboard affordance that
  // matches what users expect from a gallery overlay. We only bind while the
  // overlay is open so there's no global keydown leak when idle.
  useEffect(() => {
    if (!activeAttachment) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeAttachment, closeLightbox]);

  if (attachments.length === 0) return null;

  return (
    <div
      data-testid="message-attachments"
      className="mt-2 flex flex-wrap gap-1.5"
    >
      {attachments.map((att) => {
        const url = attachmentBlobUrl(chatId, att.id);
        return (
          <button
            key={att.id}
            type="button"
            onClick={() => setActiveId(att.id)}
            className="group/thumb relative overflow-hidden rounded-md border border-border/70 bg-muted/40 hover:border-border focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            aria-label={`Open ${att.filename}`}
            data-testid="message-attachment-thumb"
          >
            <img
              src={url}
              alt={att.filename}
              loading="lazy"
              className="block h-20 w-20 object-cover"
            />
          </button>
        );
      })}

      {activeAttachment && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeAttachment.filename}
          onClick={closeLightbox}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          data-testid="message-attachment-lightbox"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={closeLightbox}
            className="absolute right-4 top-4 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
          >
            <X className="h-5 w-5" />
          </button>
          {/* Stop propagation so clicks on the image itself don't close the
              overlay — only the backdrop / X button dismiss. */}
          <img
            src={attachmentBlobUrl(chatId, activeAttachment.id)}
            alt={activeAttachment.filename}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
});
