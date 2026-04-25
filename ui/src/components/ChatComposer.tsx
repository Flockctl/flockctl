import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Paperclip, Send, Square } from "lucide-react";
import { AttachmentChip } from "@/components/AttachmentChip";
import { uploadChatAttachment } from "@/lib/api";
import { useChatAttachmentDraft } from "@/lib/chat-attachment-draft-store";

/**
 * Hard limits mirrored from `src/services/attachments.ts`. The server is the
 * source of truth — these numbers exist so the UI can reject obviously-bad
 * uploads before the network round-trip. Keep in sync with the backend
 * constants (`MAX_ATTACHMENT_BYTES`, `MAX_ATTACHMENTS_PER_MESSAGE`).
 */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Client-side fast-fail filter for attachment types. The server performs the
 * authoritative sniff; this array just blocks the obvious non-starters (like
 * a 2 GB video someone dragged in by accident) before we burn bandwidth
 * uploading them. Empty string at the start matches "browser refused to
 * guess a MIME" and lets the file through — we'd rather let the server's
 * magic-byte sniff have the final say than reject an unlabelled CSV.
 */
function isAcceptableMime(mime: string): boolean {
  if (!mime) return true; // unknown → defer to server
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/xml") return true;
  if (mime === "application/json") return true;
  if (mime === "application/sql") return true;
  if (mime === "application/octet-stream") return true; // often used for text/code
  return false;
}

export interface ChatComposerProps {
  /**
   * The chat the composer is attached to. When null the paperclip/drop-zone
   * silently reject input — we need a chat id to POST attachments to.
   */
  chatId: string | null;
  /** Controlled textarea value. The parent owns the string so features like
   *  "suggested prompt" buttons can still prefill the field. */
  value: string;
  onChange: (next: string) => void;
  /**
   * True while a response stream is in flight. When true the Stop button
   * renders alongside Send (rather than replacing it), so the user can queue
   * a follow-up message for the next turn without waiting for the current
   * one to finish. Parent routes queued sends — see ChatConversation's
   * `handleComposerSend` for the enqueue path.
   */
  isStreaming: boolean;
  /**
   * Invoked when the user submits the turn. Attachment ids are the numeric
   * PKs returned by `POST /chats/:id/attachments`. Parent is responsible for
   * threading them into the stream call via `attachment_ids`, and for
   * deciding whether to start a new stream or enqueue the message when a
   * turn is already in flight (`isStreaming === true`).
   */
  onSend: (content: string, attachmentIds: number[]) => void | Promise<void>;
  onCancel: () => void;
  /** Optional top bar (Key / Model / PermissionMode selectors). */
  toolbar?: ReactNode;
  /** Optional footer hint (e.g. "⌘+Enter to send"). */
  hint?: ReactNode;
  /** Disables the send path entirely (no chat selected, etc.). */
  disabled?: boolean;
  /** Overrides the idle textarea placeholder. Drag-active placeholder is unaffected. */
  placeholder?: string;
}

/** Generate a local chip id for an in-flight upload. Replaced with the
 *  server's numeric attachment id once the POST resolves. */
function makePendingId(): string {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Composer footer used on the chats page. Owns the paperclip button, the
 * hidden file input, the full-area drag-and-drop zone, and the attachment
 * chip list. Client-side validation (image MIME, ≤10MB, ≤10 chips) runs
 * before each upload to mirror the server caps. The textarea itself stays
 * in the parent's control so quick-prompt buttons keep working.
 */
export function ChatComposer({
  chatId,
  value,
  onChange,
  isStreaming,
  onSend,
  onCancel,
  toolbar,
  hint,
  disabled,
  placeholder,
}: ChatComposerProps) {
  // Attachments live in a module-level per-chat store (see
  // `chat-attachment-draft-store`) so the chips survive the remount that
  // `ChatConversation` performs on every chat switch. The parent passes
  // `key={selectedChatId}`, so a plain `useState` here would wipe pending
  // screenshots whenever the user navigates away and back — even though the
  // underlying rows already exist in `chat_attachments`.
  const [attachments, setAttachments] = useChatAttachmentDraft(chatId);
  const [dragActive, setDragActive] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Clear the composer-level error banner when the active chat changes.
  // The chip list itself is keyed by chatId via the draft store, so it
  // restores automatically — no reset needed here.
  useEffect(() => {
    setGlobalError(null);
  }, [chatId]);

  const readyAttachmentIds = useMemo(
    () =>
      attachments
        .filter((a) => a.status === "ready" && typeof a.attachmentId === "number")
        .map((a) => a.attachmentId as number),
    [attachments],
  );

  const hasPendingUpload = attachments.some((a) => a.status === "uploading");

  /** Validate a single file against the client-side caps. Returns an error
   *  string on failure, null on pass. Intentionally permissive on MIME — the
   *  backend sniffs magic bytes and has the final say. */
  const validateFile = useCallback(
    (file: File, currentCount: number): string | null => {
      if (!isAcceptableMime(file.type)) {
        return `"${file.name}" is not a supported file type (${file.type}). Allowed: images, PDF, text/code.`;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return `"${file.name}" exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`;
      }
      if (currentCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
        return `up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`;
      }
      return null;
    },
    [],
  );

  const uploadOne = useCallback(
    async (file: File, pendingId: string) => {
      if (!chatId) return;
      try {
        const row = await uploadChatAttachment(chatId, file);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === pendingId
              ? {
                  ...a,
                  id: String(row.id),
                  attachmentId: row.id,
                  status: "ready",
                }
              : a,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === pendingId
              ? { ...a, status: "error", errorMessage: message }
              : a,
          ),
        );
      }
    },
    [chatId],
  );

  /**
   * Entry point for every "files just arrived" event (file picker, drop).
   * Applies client-side validation, seeds a pending chip per accepted file,
   * and fires the upload. Rejected files surface as a single composer-level
   * error string — we deliberately do NOT create error chips for rejected
   * input so the user can't accidentally "remove" them.
   */
  const ingestFiles = useCallback(
    (files: FileList | File[]) => {
      if (disabled || !chatId) return;
      const incoming = Array.from(files);
      if (incoming.length === 0) return;

      setGlobalError(null);
      const rejections: string[] = [];

      setAttachments((prev) => {
        const next = [...prev];
        for (const file of incoming) {
          const err = validateFile(file, next.length);
          if (err) {
            rejections.push(err);
            continue;
          }
          const pendingId = makePendingId();
          next.push({
            id: pendingId,
            filename: file.name,
            sizeBytes: file.size,
            status: "uploading",
          });
          // Kick off the upload outside the setState callback so React doesn't
          // re-run it on StrictMode double-invoke.
          queueMicrotask(() => void uploadOne(file, pendingId));
        }
        return next;
      });

      if (rejections.length > 0) {
        setGlobalError(rejections.join("; "));
      }
    },
    [disabled, chatId, validateFile, uploadOne],
  );

  const handleRemove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handlePaperclip = useCallback(() => {
    if (disabled || !chatId) return;
    fileInputRef.current?.click();
  }, [disabled, chatId]);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) ingestFiles(e.target.files);
      // Reset so selecting the same file again still fires a change event.
      e.target.value = "";
    },
    [ingestFiles],
  );

  const handleDragEnter = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !chatId) return;
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      setDragActive(true);
    },
    [disabled, chatId],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !chatId) return;
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled, chatId],
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Only clear when the leave event targets the outer wrapper — children
    // fire spurious dragleaves when the cursor crosses their borders.
    if (e.currentTarget === e.target) setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !chatId) return;
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer?.files?.length) {
        ingestFiles(e.dataTransfer.files);
      }
    },
    [disabled, chatId, ingestFiles],
  );

  // Send is enabled whenever the user has something to submit — including
  // while a turn is already in flight. In that case the parent routes the
  // submission into the message queue instead of starting a second concurrent
  // stream. Matches the Claude Code UX: you can line up the next prompt
  // without waiting for the current response to finish.
  const canSend =
    !disabled &&
    !!chatId &&
    !hasPendingUpload &&
    value.trim().length > 0;

  const doSend = useCallback(async () => {
    if (!canSend) return;
    const content = value.trim();
    const ids = [...readyAttachmentIds];
    // Clear local state first so the textarea is empty by the time the
    // stream starts — matches the pre-extraction UX.
    onChange("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await onSend(content, ids);
  }, [canSend, value, readyAttachmentIds, onChange, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doSend();
      }
    },
    [doSend],
  );

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 128) + "px";
    },
    [onChange],
  );

  return (
    <div className="border-t p-3" data-testid="chat-composer">
      <div className="flex w-full flex-col gap-1.5">
        {toolbar && <div className="flex items-center gap-1.5">{toolbar}</div>}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="chat-composer-chips">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} file={a} onRemove={handleRemove} />
            ))}
          </div>
        )}
        {globalError && (
          <p
            className="text-[11px] text-destructive"
            role="alert"
            data-testid="chat-composer-error"
          >
            {globalError}
          </p>
        )}
        <div
          className={`relative flex items-end gap-2 rounded-md transition-colors ${
            dragActive
              ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
              : ""
          }`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-testid="chat-composer-dropzone"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={handlePaperclip}
            disabled={disabled || !chatId || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            aria-label="Attach file"
            data-testid="chat-composer-paperclip"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            // Comprehensive accept list so the OS file picker doesn't grey
            // out non-image files. The authoritative validation lives on the
            // server (magic-byte sniff); this string is cosmetic — the file
            // input already lets users override the filter via "All Files".
            accept="image/*,application/pdf,text/*,.xml,.csv,.tsv,.json,.yaml,.yml,.md,.markdown,.log,.sql,.sh,.py,.js,.ts,.tsx,.jsx,.html,.htm,.toml,.ini,.rs,.go,.java,.c,.h,.cpp,.cs,.rb,.php,.swift,.diff,.patch"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            data-testid="chat-composer-file-input"
          />
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={
              dragActive ? "Drop file to attach…" : placeholder ?? "Type a message..."
            }
            rows={1}
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none"
            disabled={disabled || !chatId}
            data-testid="chat-composer-textarea"
          />
          {/*
            Stop renders alongside Send while a turn streams — not instead of
            it — so the user can enqueue a follow-up prompt (Send) at the same
            time they stop the running response (Stop). Esc-equivalent: Stop
            aborts only the current turn; the queue keeps draining into the
            next turn.
          */}
          {isStreaming && (
            <Button
              variant="destructive"
              size="icon"
              className="shrink-0"
              onClick={onCancel}
              data-testid="chat-composer-cancel"
              aria-label="Stop current response"
            >
              <Square className="h-4 w-4" />
            </Button>
          )}
          <Button
            size="icon"
            className="shrink-0"
            disabled={!canSend}
            onClick={() => void doSend()}
            data-testid="chat-composer-send"
            aria-label={isStreaming ? "Queue message" : "Send message"}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  );
}
