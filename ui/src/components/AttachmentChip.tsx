import { File, FileCode, FileText, Image as ImageIcon, X } from "lucide-react";

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
  /**
   * Optional remove callback. When omitted the chip renders read-only —
   * matches the slice 03 contract ("optional remove button if interactive").
   * Existing call sites (the composer) keep passing `onRemove` and behave
   * exactly as before.
   */
  onRemove?: (id: string) => void;
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
  "heic",
  "heif",
]);

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "sh",
  "zsh",
  "bash",
  "sql",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "scss",
]);

const TEXT_EXTS = new Set(["pdf", "txt", "md", "markdown", "rtf", "log", "csv", "tsv"]);

type TypeKind = "image" | "text" | "code" | "file";

/**
 * Classify the file by its extension into one of four icon "kinds":
 *   - `image` (png, jpg, …)
 *   - `text` (pdf, txt, md, …)
 *   - `code` (ts, py, …)
 *   - `file` (everything else / no extension)
 *
 * Returning a string instead of a component reference keeps the render
 * path lint-clean (the eslint `react-hooks/static-components` rule flags
 * "components created during render" for `const Icon = …; <Icon />`).
 */
function pickTypeKind(filename: string): TypeKind {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  if (CODE_EXTS.has(ext)) return "code";
  return "file";
}

function TypeIcon({ kind }: { kind: TypeKind }) {
  const cls = "h-3 w-3 shrink-0";
  switch (kind) {
    case "image":
      return <ImageIcon className={cls} data-testid="attachment-chip-icon" />;
    case "text":
      return <FileText className={cls} data-testid="attachment-chip-icon" />;
    case "code":
      return <FileCode className={cls} data-testid="attachment-chip-icon" />;
    case "file":
    default:
      return <File className={cls} data-testid="attachment-chip-icon" />;
  }
}

/**
 * Render one pending/finished attachment as a removable chip. Used by the
 * `ChatComposer` above the textarea. Disabled-looking state during upload,
 * red border on validation/network errors. The remove button is rendered
 * only when an `onRemove` handler is supplied (read-only chips don't show
 * an X) — matches the slice 03 "optional remove button" contract.
 *
 * Visual contract (slice 03):
 *   - rounded-md border container
 *   - leading type-icon (image / pdf / code / file fallback)
 *   - filename label (truncated past 18rem with title fallback)
 *   - tabular-nums KB size (or "…" placeholder while uploading)
 *   - optional X remove button on the right
 */
export function AttachmentChip({ file, onRemove }: AttachmentChipProps) {
  const sizeKb = Math.max(1, Math.round(file.sizeBytes / 1024));
  const isError = file.status === "error";
  const isUploading = file.status === "uploading";
  const typeKind = pickTypeKind(file.filename);
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
      <TypeIcon kind={typeKind} />
      <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      <span className="shrink-0 tabular-nums text-[10px] opacity-70">
        {isUploading ? "…" : `${sizeKb} KB`}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.filename}`}
          onClick={() => onRemove(file.id)}
          className="-mr-0.5 ml-0.5 rounded p-0.5 hover:bg-foreground/10"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
