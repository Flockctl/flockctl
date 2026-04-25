import { X, Paperclip } from "lucide-react";

export interface AttachmentChipFile {
  /**
   * Stable id used by the composer to track the chip while it is in flight
   * and after upload. Locally-generated `pending-…` ids are swapped for the
   * server-issued numeric attachment id once the upload resolves.
   */
  id: string;
  filename: string;
  sizeBytes: number;
  /** "uploading" → "ready" once the POST resolves; "error" on failure. */
  status: "uploading" | "ready" | "error";
  /** Backend attachment id — only set after the upload succeeds. */
  attachmentId?: number;
  errorMessage?: string;
}

interface AttachmentChipProps {
  file: AttachmentChipFile;
  onRemove: (id: string) => void;
}

/**
 * Render one pending/finished attachment as a removable chip. Used by the
 * ChatComposer above the textarea. Disabled-looking state during upload, red
 * border on validation/network errors. The remove button is always live so
 * the user can cancel a stuck upload.
 */
export function AttachmentChip({ file, onRemove }: AttachmentChipProps) {
  const sizeKb = Math.max(1, Math.round(file.sizeBytes / 1024));
  const isError = file.status === "error";
  const isUploading = file.status === "uploading";
  return (
    <div
      data-testid="attachment-chip"
      data-status={file.status}
      className={`group inline-flex max-w-[18rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
        isError
          ? "border-destructive bg-destructive/10 text-destructive"
          : isUploading
          ? "border-dashed border-muted-foreground/40 bg-muted/40 text-muted-foreground"
          : "border-border bg-muted/40"
      }`}
      title={isError ? (file.errorMessage ?? "Upload failed") : file.filename}
    >
      <Paperclip className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      <span className="shrink-0 tabular-nums text-[10px] opacity-70">
        {isUploading ? "…" : `${sizeKb} KB`}
      </span>
      <button
        type="button"
        aria-label={`Remove ${file.filename}`}
        onClick={() => onRemove(file.id)}
        className="-mr-0.5 ml-0.5 rounded p-0.5 hover:bg-foreground/10"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
