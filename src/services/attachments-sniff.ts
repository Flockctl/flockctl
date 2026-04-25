import { extname } from "path";

/**
 * Pure helpers for classifying uploaded attachment bytes. Factored out of
 * `attachments.ts` so the stateless sniff layer can be re-used (and tested)
 * without pulling in DB / filesystem dependencies.
 */

export type AttachmentKind = "image" | "pdf" | "text";

export interface SniffResult {
  kind: AttachmentKind;
  mime: string;
  ext: string;
}

/**
 * Sniff magic bytes of an image buffer. Only PNG, JPEG, WEBP, and GIF are
 * accepted — every other byte sequence returns null. Kept as a named export
 * because existing call sites (and tests) use it to check image-only paths.
 */
export function sniffImageType(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }

  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // GIF — "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" };
  }

  // WEBP — "RIFF....WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

/** PDF magic bytes — "%PDF-" at the start. */
function sniffPdfType(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 5) return null;
  if (
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  ) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  return null;
}

/**
 * Heuristic check for text-like content. Samples the first 8 KB of the buffer
 * and rejects it when a NUL byte (0x00) appears or when the bytes do not
 * decode as valid UTF-8. Claude's document block with PlainTextSource only
 * accepts UTF-8, so accepting anything more permissive here would just
 * explode downstream when the model call forwards the content. Keeps the
 * check cheap — no need to decode the whole file.
 */
function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8 * 1024));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a stable text MIME for display + the stored attachment row. Maps a
 * handful of well-known extensions to their canonical `text/*` or
 * `application/*` form (so XML/JSON/CSV files surface with the right tag in
 * the UI) and falls back to `text/plain` for everything else. The model
 * only cares that the block is a PlainTextSource — the precise media type
 * is cosmetic downstream.
 */
function textMimeForFilename(filename: string): { mime: string; ext: string } {
  const lower = filename.toLowerCase();
  const ext = extname(lower).replace(/^\./, "");
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    yaml: "text/yaml",
    yml: "text/yaml",
    toml: "text/plain",
    ini: "text/plain",
    log: "text/plain",
    js: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    jsx: "text/javascript",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
    java: "text/x-java",
    c: "text/x-c",
    h: "text/x-c",
    cpp: "text/x-c++",
    cs: "text/x-csharp",
    rb: "text/x-ruby",
    php: "text/x-php",
    swift: "text/x-swift",
    sh: "text/x-shellscript",
    sql: "application/sql",
    diff: "text/x-diff",
    patch: "text/x-diff",
  };
  const mime = map[ext] ?? "text/plain";
  return { mime, ext: ext || "txt" };
}

/**
 * Unified sniff across every supported kind. Returns the canonical MIME + a
 * filesystem extension that's safe to stick on the stored UUID filename.
 * Images win first (cheap magic-byte check), then PDF, then we fall back to
 * the text heuristic. Any binary blob we can't classify returns null and the
 * caller should reject the upload as unsupported.
 */
export function sniffAttachmentType(
  buf: Buffer,
  filename: string,
): SniffResult | null {
  const image = sniffImageType(buf);
  if (image) return { kind: "image", ...image };

  const pdf = sniffPdfType(buf);
  if (pdf) return { kind: "pdf", ...pdf };

  if (looksLikeText(buf)) {
    const { mime, ext } = textMimeForFilename(filename);
    return { kind: "text", mime, ext };
  }

  return null;
}

/**
 * Strip path separators (`/`, `\`) and control chars from the original
 * filename. The filename column is display-only, but we still scrub it so a
 * hostile value can't confuse log viewers or downstream consumers.
 */
export function sanitizeFilename(raw: string): string {
  if (typeof raw !== "string") return "file";
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control chars
    if (ch === "/" || ch === "\\") continue; // path separators
    out += ch;
  }
  out = out.trim();
  if (out === "" || out === "." || out === "..") return "file";
  return out.slice(0, 255);
}
