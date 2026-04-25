import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Mocks ──────────────────────────────────────────────────────────────────
// The chat-message endpoints kick off an AgentSession and would otherwise try
// to talk to the Claude CLI. Stub it out — every test in this file is scoped
// to DB/persistence behaviour, not the AI round-trip. Kept above the server
// import because `vi.mock` is hoisted and must beat the module graph.
vi.mock("../../services/agent-session/index", async () => {
  const { EventEmitter } = await import("events");
  class MockAgentSession extends EventEmitter {
    constructor(_opts: unknown) {
      super();
    }
    async run() {
      this.emit("text", "ok");
      this.emit("usage", {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
      });
      this.emit("session_id", "mock-session");
    }
    abort() {}
    resolvePermission() {
      return false;
    }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb, getDb } from "../../db/index.js";
import { chats, chatAttachments, chatMessages } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  sweepOrphans,
  getAttachmentsRoot,
  sniffImageType,
  sniffAttachmentType,
  sanitizeFilename,
  attachmentToImageBlock,
  attachmentToPdfDocumentBlock,
  attachmentToTextDocumentBlock,
  buildMessageContent,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_TEXT_BYTES,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
} from "../../services/attachments.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

// A 1x1 PNG — the smallest spec-compliant blob. We use this literal buffer
// instead of generating one at runtime so the magic-byte assertion is
// deterministic and doesn't depend on any image encoder being installed.
const ONE_PX_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

// A 1x1 JPEG (minimal valid SOI/EOI wrapped). Used for the MIME mismatch test.
const ONE_PX_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08,
  0xff, 0xd9,
]);

// Minimal-but-valid PDF header. `%PDF-` is the magic prefix the sniffer
// looks for; the rest is a tiny 1-page document whose contents we don't
// care about — the sniff only checks the first five bytes.
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf-8",
);

let fakeHome: string;
let originalHome: string | undefined;
let chatId: number;

async function postFile(
  path: string,
  bytes: Buffer,
  filename: string,
  mime: string,
): Promise<Response> {
  const form = new FormData();
  // Copy the Buffer into a fresh Uint8Array — lets the cast line up with
  // Blob's strict ArrayBuffer (not SharedArrayBuffer) requirement.
  const u8 = new Uint8Array(bytes.byteLength);
  u8.set(bytes);
  const blob = new Blob([u8], { type: mime });
  form.append("file", blob, filename);
  return app.request(path, {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "flockctl-attachments-test-"));
  originalHome = process.env.FLOCKCTL_HOME;
  process.env.FLOCKCTL_HOME = fakeHome;

  const testDb = createTestDb();
  setDb(testDb.db, testDb.sqlite);

  const chat = testDb.db
    .insert(chats)
    .values({ title: "attachments test" })
    .returning()
    .get();
  chatId = chat.id;
});

afterEach(() => {
  closeDb();
  if (originalHome !== undefined) process.env.FLOCKCTL_HOME = originalHome;
  else delete process.env.FLOCKCTL_HOME;
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── Unit — pure helpers ────────────────────────────────────────────────────

describe("attachments service — pure helpers", () => {
  it("sniffImageType recognizes PNG, JPEG, GIF, WEBP", () => {
    expect(sniffImageType(ONE_PX_PNG)?.mime).toBe("image/png");
    expect(sniffImageType(ONE_PX_JPEG)?.mime).toBe("image/jpeg");

    const gif = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.alloc(10, 0),
    ]);
    expect(sniffImageType(gif)?.mime).toBe("image/gif");

    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP"),
      Buffer.alloc(4, 0),
    ]);
    expect(sniffImageType(webp)?.mime).toBe("image/webp");
  });

  it("sniffImageType rejects unsupported content", () => {
    expect(sniffImageType(Buffer.from("hello world padded enough"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
  });

  it("sniffAttachmentType classifies PDFs, text, and rejects binary blobs", () => {
    // Image wins first
    expect(sniffAttachmentType(ONE_PX_PNG, "x.png")?.kind).toBe("image");

    // PDF matches the %PDF- magic prefix
    const pdf = sniffAttachmentType(TINY_PDF, "x.pdf");
    expect(pdf?.kind).toBe("pdf");
    expect(pdf?.mime).toBe("application/pdf");

    // Text-like content maps to the canonical MIME for the extension
    const csv = sniffAttachmentType(
      Buffer.from("a,b,c\n1,2,3\n"),
      "data.csv",
    );
    expect(csv?.kind).toBe("text");
    expect(csv?.mime).toBe("text/csv");

    const xml = sniffAttachmentType(
      Buffer.from("<?xml version='1.0'?><root />"),
      "data.xml",
    );
    expect(xml?.kind).toBe("text");
    expect(xml?.mime).toBe("application/xml");

    const json = sniffAttachmentType(
      Buffer.from('{"ok":true}'),
      "data.json",
    );
    expect(json?.kind).toBe("text");
    expect(json?.mime).toBe("application/json");

    const md = sniffAttachmentType(
      Buffer.from("# Hello\n\nbody"),
      "notes.md",
    );
    expect(md?.kind).toBe("text");
    expect(md?.mime).toBe("text/markdown");

    // Unknown extensions fall back to text/plain as long as the content
    // decodes as UTF-8.
    const plain = sniffAttachmentType(
      Buffer.from("just some plain text without an extension"),
      "README",
    );
    expect(plain?.kind).toBe("text");
    expect(plain?.mime).toBe("text/plain");

    // A buffer with embedded NULs is neither text nor a known binary format
    // — refuse it.
    expect(
      sniffAttachmentType(
        Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x90, 0xc3, 0x28]),
        "blob.bin",
      ),
    ).toBeNull();

    // Empty buffer is always null.
    expect(sniffAttachmentType(Buffer.alloc(0), "empty.txt")).toBeNull();
  });

  it("sanitizeFilename strips path separators and control chars", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFilename("a\\b/c")).toBe("abc");
    expect(sanitizeFilename("hello\x00\x1fworld")).toBe("helloworld");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("normal.png")).toBe("normal.png");
  });
});

// ─── content-block builders ─────────────────────────────────────────────────
// Small, focused suite exercising the ImageBlockParam / DocumentBlockParam
// shaping helpers directly — no HTTP, no DB. They're what the agent session
// eventually hands to the Anthropic SDK, so shape regressions here break
// every chat turn that ships an attachment.

describe("attachments service — content-block builders", () => {
  let blobDir: string;

  beforeEach(() => {
    blobDir = mkdtempSync(join(tmpdir(), "flockctl-att-blocks-"));
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  function writeBlob(name: string, data: Buffer): string {
    const p = join(blobDir, name);
    writeFileSync(p, data);
    return p;
  }

  it("attachmentToImageBlock returns a base64 image block for a known image MIME", () => {
    const p = writeBlob("one.png", ONE_PX_PNG);
    const block = attachmentToImageBlock({ path: p, mimeType: "image/png" });
    expect(block).not.toBeNull();
    expect(block!.type).toBe("image");
    expect(block!.source.type).toBe("base64");
    if (block!.source.type === "base64") {
      expect(block!.source.media_type).toBe("image/png");
      expect(block!.source.data).toBe(ONE_PX_PNG.toString("base64"));
    }
  });

  it("attachmentToImageBlock returns null for unsupported MIME and missing files", () => {
    const p = writeBlob("pdf.pdf", TINY_PDF);
    // Wrong MIME for the builder.
    expect(
      attachmentToImageBlock({ path: p, mimeType: "application/pdf" }),
    ).toBeNull();
    // Missing file on disk — readFileSync throws, builder logs + returns null.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      attachmentToImageBlock({
        path: join(blobDir, "ghost.png"),
        mimeType: "image/png",
      }),
    ).toBeNull();
    warn.mockRestore();
  });

  it("attachmentToPdfDocumentBlock wraps the PDF bytes as a base64 DocumentBlockParam", () => {
    const p = writeBlob("doc.pdf", TINY_PDF);
    const block = attachmentToPdfDocumentBlock({
      path: p,
      mimeType: "application/pdf",
      filename: "doc.pdf",
    });
    expect(block).not.toBeNull();
    expect(block!.type).toBe("document");
    expect(block!.source.type).toBe("base64");
    if (block!.source.type === "base64") {
      expect(block!.source.media_type).toBe("application/pdf");
      expect(block!.source.data).toBe(TINY_PDF.toString("base64"));
    }
    expect(block!.title).toBe("doc.pdf");
  });

  it("attachmentToPdfDocumentBlock rejects non-PDF MIME and missing files", () => {
    const p = writeBlob("img.png", ONE_PX_PNG);
    expect(
      attachmentToPdfDocumentBlock({
        path: p,
        mimeType: "image/png",
        filename: "img.png",
      }),
    ).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      attachmentToPdfDocumentBlock({
        path: join(blobDir, "ghost.pdf"),
        mimeType: "application/pdf",
        filename: "ghost.pdf",
      }),
    ).toBeNull();
    warn.mockRestore();
  });

  it("attachmentToTextDocumentBlock decodes UTF-8 and preserves content for text-like MIME", () => {
    const body = "col1,col2\nалма,яблоко\n"; // intentionally multi-byte UTF-8
    const p = writeBlob("data.csv", Buffer.from(body, "utf-8"));
    const block = attachmentToTextDocumentBlock({
      path: p,
      mimeType: "text/csv",
      filename: "data.csv",
    });
    expect(block).not.toBeNull();
    expect(block!.type).toBe("document");
    expect(block!.source.type).toBe("text");
    if (block!.source.type === "text") {
      expect(block!.source.media_type).toBe("text/plain");
      expect(block!.source.data).toBe(body);
    }
    expect(block!.title).toBe("data.csv");
  });

  it("attachmentToTextDocumentBlock truncates oversized text and appends a marker", () => {
    // 1 MB + 1 KB of ASCII 'x' — crosses the MAX_INLINE_TEXT_BYTES gate.
    const bigLen = MAX_INLINE_TEXT_BYTES + 1024;
    const big = Buffer.alloc(bigLen, 0x78);
    const p = writeBlob("huge.txt", big);
    const block = attachmentToTextDocumentBlock({
      path: p,
      mimeType: "text/plain",
      filename: "huge.txt",
    });
    expect(block).not.toBeNull();
    if (block!.source.type === "text") {
      expect(block!.source.data.startsWith("x".repeat(1000))).toBe(true);
      expect(block!.source.data).toContain("[truncated");
      expect(block!.source.data).toContain(String(bigLen));
      // Prefix is exactly MAX_INLINE_TEXT_BYTES chars (ASCII so bytes == chars).
      expect(
        block!.source.data.length > MAX_INLINE_TEXT_BYTES,
      ).toBe(true);
    }
  });

  it("attachmentToTextDocumentBlock returns null for non-UTF-8 bytes and unsupported MIME", () => {
    // Invalid UTF-8 sequence (0xC3 0x28 is a bad continuation byte).
    const bad = writeBlob("bad.txt", Buffer.from([0xc3, 0x28, 0xc3, 0x28]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      attachmentToTextDocumentBlock({
        path: bad,
        mimeType: "text/plain",
        filename: "bad.txt",
      }),
    ).toBeNull();

    // Unsupported MIME — e.g. application/octet-stream should not produce a
    // text document block.
    const ok = writeBlob("ok.txt", Buffer.from("hello"));
    expect(
      attachmentToTextDocumentBlock({
        path: ok,
        mimeType: "application/octet-stream",
        filename: "ok.txt",
      }),
    ).toBeNull();

    // Missing file.
    expect(
      attachmentToTextDocumentBlock({
        path: join(blobDir, "ghost.txt"),
        mimeType: "text/plain",
        filename: "ghost.txt",
      }),
    ).toBeNull();
    warn.mockRestore();
  });

  it("buildMessageContent returns the plain text string when there are no attachments", () => {
    expect(buildMessageContent("hello", undefined)).toBe("hello");
    expect(buildMessageContent("hello", [])).toBe("hello");
  });

  it("buildMessageContent emits a ContentBlockParam[] that mixes image + PDF + text blocks", () => {
    const imgPath = writeBlob("one.png", ONE_PX_PNG);
    const pdfPath = writeBlob("doc.pdf", TINY_PDF);
    const txtPath = writeBlob("note.txt", Buffer.from("hello world"));
    const result = buildMessageContent("prose", [
      { path: imgPath, mimeType: "image/png", filename: "one.png" },
      { path: pdfPath, mimeType: "application/pdf", filename: "doc.pdf" },
      { path: txtPath, mimeType: "text/plain", filename: "note.txt" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "text", text: "prose" });
    expect(result[1]!.type).toBe("image");
    expect(result[2]!.type).toBe("document");
    expect(result[3]!.type).toBe("document");
    // Order matches caller order.
    if (result[2]!.type === "document" && result[2]!.source.type === "base64") {
      expect(result[2]!.source.media_type).toBe("application/pdf");
    }
    if (result[3]!.type === "document" && result[3]!.source.type === "text") {
      expect(result[3]!.source.data).toBe("hello world");
    }
  });

  it("buildMessageContent silently skips unsupported MIMEs and falls back to string when every block fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Two rows, neither produces a block: one unsupported MIME, one missing
    // file. buildMessageContent collapses back to the plain text string.
    const result = buildMessageContent("text only", [
      {
        path: join(blobDir, "ghost.bin"),
        mimeType: "application/x-custom",
        filename: "ghost.bin",
      },
      {
        path: join(blobDir, "ghost2.png"),
        mimeType: "image/png",
        filename: "ghost2.png",
      },
    ]);
    expect(result).toBe("text only");
    warn.mockRestore();
  });
});

// ─── POST /chats/:id/attachments ────────────────────────────────────────────

describe("POST /chats/:id/attachments — happy path", () => {
  it("writes the file under ~/flockctl/attachments/{chatId} and inserts a row", async () => {
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "hello.png",
      "image/png",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: number;
      chatId: number;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      path: string;
    };
    expect(row.chatId).toBe(chatId);
    expect(row.filename).toBe("hello.png");
    expect(row.mimeType).toBe("image/png");
    expect(row.sizeBytes).toBe(ONE_PX_PNG.length);
    expect(row.path).toMatch(/\.png$/);
    expect(row.path.startsWith(getAttachmentsRoot())).toBe(true);
    expect(existsSync(row.path)).toBe(true);

    // DB row was persisted too
    const persisted = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.id, row.id))
      .get();
    expect(persisted?.path).toBe(row.path);
  });

  it("accepts a PDF upload and stores it as application/pdf", async () => {
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      TINY_PDF,
      "report.pdf",
      "application/pdf",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      mimeType: string;
      path: string;
      sizeBytes: number;
      filename: string;
    };
    expect(row.mimeType).toBe("application/pdf");
    expect(row.filename).toBe("report.pdf");
    expect(row.sizeBytes).toBe(TINY_PDF.length);
    expect(row.path).toMatch(/\.pdf$/);
    expect(existsSync(row.path)).toBe(true);
  });

  it("accepts a CSV upload and canonicalizes the MIME", async () => {
    const csvBytes = Buffer.from("name,age\nalice,30\nbob,25\n");
    // Browsers sometimes send the "wrong" MIME for CSVs (text/plain,
    // application/vnd.ms-excel, empty string, etc.). The server's sniff
    // should paper over all of these and store the row as text/csv based
    // on the filename extension.
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      csvBytes,
      "people.csv",
      "application/vnd.ms-excel",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { mimeType: string; filename: string };
    expect(row.mimeType).toBe("text/csv");
    expect(row.filename).toBe("people.csv");
  });

  it("accepts an XML upload", async () => {
    const xml = Buffer.from(
      "<?xml version='1.0'?><rss><channel><title>Hi</title></channel></rss>",
    );
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      xml,
      "feed.xml",
      "application/xml",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { mimeType: string };
    expect(row.mimeType).toBe("application/xml");
  });

  it("accepts a JSON upload", async () => {
    const json = Buffer.from('{"hello":"world"}');
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      json,
      "config.json",
      "application/json",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { mimeType: string };
    expect(row.mimeType).toBe("application/json");
  });

  it("accepts a plain text upload even when the browser sends no MIME at all", async () => {
    const txt = Buffer.from("just some notes in a file");
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      txt,
      "notes.txt",
      "",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { mimeType: string };
    expect(row.mimeType).toBe("text/plain");
  });
});

// ─── POST /chats/:id/attachments — validation ──────────────────────────────

describe("POST /chats/:id/attachments — validation", () => {
  it("rejects with 422 when client MIME != sniffed MIME", async () => {
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "lies.jpg",
      "image/jpeg", // claimed JPEG, bytes are PNG
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not match sniffed/i);

    // No on-disk leak — the attachments root should be empty / missing.
    const dir = join(getAttachmentsRoot(), String(chatId));
    if (existsSync(dir)) {
      expect(readdirSync(dir)).toHaveLength(0);
    }

    // No DB row
    const rows = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .all();
    expect(rows).toHaveLength(0);
  });

  it(`rejects with 422 when file exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`, async () => {
    // One byte over the per-file cap, with a PNG header prefix. We never
    // actually sniff it because the size gate runs first — the buffer just
    // needs to cross the limit.
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0);
    ONE_PX_PNG.copy(oversize, 0); // PNG magic prefix so it could have been valid
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      oversize,
      "big.png",
      "image/png",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds|too large/i);
  });

  it("rejects with 422 when client claims image but content is not an image", async () => {
    // Plain ASCII would normally be accepted as a text attachment, but the
    // client declared `image/png` — that's a spoofing attempt, not an
    // accidental text upload, so the backend refuses it with a MIME
    // mismatch instead of silently reclassifying it as text.
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      Buffer.from("not really an image, just ascii"),
      "fake.png",
      "image/png",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not match/i);
  });

  it("rejects truly unsupported binary content", async () => {
    // A buffer that is neither a known image, nor a PDF, nor valid UTF-8
    // text (embedded NULs + invalid sequences). The unified sniff returns
    // null and the upload is refused.
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x80, 0x90, 0xc3, 0x28]);
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      binary,
      "blob.bin",
      "application/octet-stream",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unsupported/i);
  });

  it("sanitizes path traversal in the original filename before storing", async () => {
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "../../../../etc/passwd.png",
      "image/png",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { filename: string; path: string };

    // Filename is sanitized — no slashes survive.
    expect(row.filename).not.toContain("/");
    expect(row.filename).not.toContain("\\");

    // On-disk path stays within the attachments root — path traversal is
    // impossible because we generate the real filename from a UUID, never
    // from user input.
    expect(row.path.startsWith(getAttachmentsRoot())).toBe(true);
    expect(row.path).not.toContain("..");
  });

  it("returns 404 for a missing chat", async () => {
    const res = await postFile(
      `/chats/99999/attachments`,
      ONE_PX_PNG,
      "hello.png",
      "image/png",
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 when the multipart body has no file field", async () => {
    const form = new FormData();
    form.append("other", "noop");
    const res = await app.request(`/chats/${chatId}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(422);
  });
});

// ─── Cascade on chat delete ─────────────────────────────────────────────────

describe("DELETE /chats/:id cascades to attachment blobs", () => {
  it("removes the on-disk file when the chat is deleted", async () => {
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "one.png",
      "image/png",
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { path: string; id: number };
    expect(existsSync(row.path)).toBe(true);

    const del = await app.request(`/chats/${chatId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // DB row cascade-deleted
    const remaining = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.id, row.id))
      .get();
    expect(remaining).toBeUndefined();

    // File on disk gone
    expect(existsSync(row.path)).toBe(false);
  });
});

// ─── sweepOrphans ──────────────────────────────────────────────────────────

describe("sweepOrphans", () => {
  it("is a no-op when the attachments root does not exist", () => {
    // Fresh fakeHome — root dir never created.
    const out = sweepOrphans();
    expect(out).toEqual({ scanned: 0, removed: 0 });
  });

  it("removes files on disk that have no matching DB row, keeps tracked files", async () => {
    // 1. Upload a real attachment — creates a tracked file + DB row.
    const res = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "tracked.png",
      "image/png",
    );
    expect(res.status).toBe(201);
    const tracked = (await res.json()) as { path: string };

    // 2. Drop an orphan blob into the same chat dir, plus a second in a
    //    different chat's directory.
    const chatDir = join(getAttachmentsRoot(), String(chatId));
    const orphanInChat = join(chatDir, "orphan-in-chat.png");
    writeFileSync(orphanInChat, ONE_PX_PNG);

    const ghostChatDir = join(getAttachmentsRoot(), "9999");
    mkdirSync(ghostChatDir, { recursive: true });
    const orphanInGhost = join(ghostChatDir, "ghost.png");
    writeFileSync(orphanInGhost, ONE_PX_PNG);

    expect(existsSync(tracked.path)).toBe(true);
    expect(existsSync(orphanInChat)).toBe(true);
    expect(existsSync(orphanInGhost)).toBe(true);

    const out = sweepOrphans();
    expect(out.removed).toBe(2);
    expect(out.scanned).toBeGreaterThanOrEqual(3);

    // Tracked file survived
    expect(existsSync(tracked.path)).toBe(true);
    // Orphans gone
    expect(existsSync(orphanInChat)).toBe(false);
    expect(existsSync(orphanInGhost)).toBe(false);
    // Empty ghost dir is cleaned up
    expect(existsSync(ghostChatDir)).toBe(false);
  });
});

// ─── attachment_ids on POST /chats/:id/messages ────────────────────────────
//
// Slice 01 task 00 persists linkage only — the AgentSession mock swallows the
// AI round-trip. These tests assert DB state + response shape, not the
// eventual multimodal forwarding.

/** Upload a blob and return its attachment row. */
async function uploadAttachment(
  cid: number,
  bytes: Buffer = ONE_PX_PNG,
  filename = "a.png",
  mime = "image/png",
): Promise<{ id: number; sizeBytes: number; path: string }> {
  const res = await postFile(`/chats/${cid}/attachments`, bytes, filename, mime);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number; sizeBytes: number; path: string };
}

describe("POST /chats/:id/messages — attachment_ids", () => {
  it("links attachments to the persisted user message", async () => {
    const a1 = await uploadAttachment(chatId, ONE_PX_PNG, "one.png");
    const a2 = await uploadAttachment(chatId, ONE_PX_PNG, "two.png");

    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "look at these",
        attachment_ids: [a1.id, a2.id],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      userMessage: {
        id: number;
        role: string;
        attachments: Array<{ id: number; messageId: number; filename: string }>;
      };
    };

    // Response echoes linked attachments in caller order
    expect(body.userMessage.role).toBe("user");
    expect(body.userMessage.attachments).toHaveLength(2);
    expect(body.userMessage.attachments.map((a) => a.id)).toEqual([a1.id, a2.id]);
    for (const a of body.userMessage.attachments) {
      expect(a.messageId).toBe(body.userMessage.id);
    }

    // DB — message_id column is populated on both rows
    const rows = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .all();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.messageId).toBe(body.userMessage.id);
    }
  });

  it("treats empty attachment_ids identically to an absent field", async () => {
    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no attachments", attachment_ids: [] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      userMessage: { attachments: unknown[] };
    };
    expect(body.userMessage.attachments).toEqual([]);
  });

  it("rejects attachment_ids belonging to a different chat (422)", async () => {
    const a = await uploadAttachment(chatId);

    const other = getDb()
      .insert(chats)
      .values({ title: "other" })
      .returning()
      .get();

    const res = await app.request(`/chats/${other.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "steal", attachment_ids: [a.id] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not belong/i);

    // No dangling user message was persisted on the second chat
    const msgs = getDb()
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, other.id))
      .all();
    expect(msgs).toHaveLength(0);

    // Original attachment still unlinked
    const row = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.id, a.id))
      .get();
    expect(row?.messageId).toBeNull();
  });

  it("rejects attachment_ids that are already linked to a prior message (422)", async () => {
    const a = await uploadAttachment(chatId);

    // First send — links the attachment.
    const first = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "first", attachment_ids: [a.id] }),
    });
    expect(first.status).toBe(201);

    // Second send reusing the same id must fail.
    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "second", attachment_ids: [a.id] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already linked/i);
  });

  it("rejects a non-existent attachment id (422)", async () => {
    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ghost", attachment_ids: [9999999] }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects more than 10 attachment_ids with a Zod shape error (422)", async () => {
    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "too many",
        // 11 ids — exceeds MAX_ATTACHMENTS_PER_MESSAGE. Values do not need to
        // exist; Zod bails before we hit the DB.
        attachment_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/attachment_ids|too many|at most|10/i);
  });

  it(`rejects total attachment size > ${MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB (422)`, async () => {
    // Stub rows directly — bypasses the per-file cap on the upload endpoint
    // but exercises the aggregate-size gate on the message endpoint. We aim
    // for ~3x individual files totalling well over the per-message cap.
    const fakePath = (n: number) => join(getAttachmentsRoot(), `fake-${n}.png`);
    // Each row half the per-file cap ⇒ 3 of them = 1.5x per-file cap ⇒
    // guaranteed over the per-message total cap.
    const bigOne = Math.floor(MAX_ATTACHMENT_BYTES * 0.5);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const row = getDb()
        .insert(chatAttachments)
        .values({
          chatId,
          filename: `big-${i}.png`,
          mimeType: "image/png",
          sizeBytes: bigOne,
          path: fakePath(i),
        })
        .returning()
        .get();
      ids.push(row.id);
    }

    const res = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "oversized", attachment_ids: ids }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds|total attachment size/i);

    // None of the rows should have been linked
    const rows = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .all();
    for (const r of rows) {
      expect(r.messageId).toBeNull();
    }
  });
});

// ─── attachment_ids on POST /chats/:id/messages/stream ─────────────────────

describe("POST /chats/:id/messages/stream — attachment_ids", () => {
  it("links attachments and emits them in the initial SSE frame", async () => {
    const a1 = await uploadAttachment(chatId, ONE_PX_PNG, "s1.png");
    const a2 = await uploadAttachment(chatId, ONE_PX_PNG, "s2.png");

    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "with attachments",
        attachment_ids: [a1.id, a2.id],
      }),
    });
    expect(res.status).toBe(200);

    // Drain the stream so the linking UPDATE completes before we assert.
    const text = await res.text();

    // Preamble event carries the user_message + linked attachments
    expect(text).toMatch(/"user_message"/);
    expect(text).toMatch(new RegExp(`"id":\\s*${a1.id}`));
    expect(text).toMatch(new RegExp(`"id":\\s*${a2.id}`));

    // DB — both attachments link to the newly inserted user message
    const userMsgs = getDb()
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .all()
      .filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    const latestUserMsg = userMsgs[userMsgs.length - 1];

    const linked = getDb()
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .all();
    expect(linked).toHaveLength(2);
    for (const r of linked) {
      expect(r.messageId).toBe(latestUserMsg.id);
    }
  });

  it("rejects invalid attachment_ids with 422 before opening the stream", async () => {
    const other = getDb()
      .insert(chats)
      .values({ title: "other-stream" })
      .returning()
      .get();
    const foreign = await uploadAttachment(other.id);

    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "steal via stream",
        attachment_ids: [foreign.id],
      }),
    });
    expect(res.status).toBe(422);

    // No user message persisted on this chat
    const msgs = getDb()
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .all();
    expect(msgs).toHaveLength(0);
  });
});

// ─── GET /chats/:id/attachments/:attId/blob ────────────────────────────────
//
// The blob endpoint is the thumbnail / lightbox source for the chat
// transcript. We assert: (a) a matching chat+att pair streams the exact
// bytes back with the stored mime + nosniff header; (b) a different chat's
// attachment id collapses to 404 (no cross-chat probing); (c) a row whose
// on-disk file was unlinked behind the DB's back also collapses to 404,
// indistinguishably from a wrong chat.

describe("GET /chats/:id/attachments/:attId/blob", () => {
  it("streams the file with the stored mime type + nosniff headers", async () => {
    const up = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "thumb.png",
      "image/png",
    );
    expect(up.status).toBe(201);
    const row = (await up.json()) as { id: number; path: string };

    const res = await app.request(`/chats/${chatId}/attachments/${row.id}/blob`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);

    // Bytes round-trip unchanged (exact magic-prefix match is proof enough
    // that we streamed the on-disk file rather than a re-encoded copy).
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    expect(bytes.length).toBe(ONE_PX_PNG.length);
    expect(bytes.equals(ONE_PX_PNG)).toBe(true);
  });

  it("returns 404 when the attachment belongs to a different chat", async () => {
    // Upload into chat A, then try to fetch its id from chat B's route.
    const up = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "owned.png",
      "image/png",
    );
    expect(up.status).toBe(201);
    const row = (await up.json()) as { id: number };

    const other = getDb()
      .insert(chats)
      .values({ title: "other-blob" })
      .returning()
      .get();

    const res = await app.request(
      `/chats/${other.id}/attachments/${row.id}/blob`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the on-disk file is missing", async () => {
    const up = await postFile(
      `/chats/${chatId}/attachments`,
      ONE_PX_PNG,
      "ghost.png",
      "image/png",
    );
    expect(up.status).toBe(201);
    const row = (await up.json()) as { id: number; path: string };

    // Simulate external tampering / sweep: blob gone, DB row left behind.
    unlinkSync(row.path);
    expect(existsSync(row.path)).toBe(false);

    const res = await app.request(
      `/chats/${chatId}/attachments/${row.id}/blob`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown attachment id", async () => {
    const res = await app.request(
      `/chats/${chatId}/attachments/9999999/blob`,
    );
    expect(res.status).toBe(404);
  });
});

// ─── GET /chats/:id includes linked attachments per message ────────────────

describe("GET /chats/:id — message attachments", () => {
  it("embeds linked attachments on each user message", async () => {
    const a = await uploadAttachment(chatId, ONE_PX_PNG, "att.png");
    const send = await app.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "look", attachment_ids: [a.id] }),
    });
    expect(send.status).toBe(201);

    const res = await app.request(`/chats/${chatId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: number;
        role: string;
        attachments: Array<{ id: number; filename: string; mimeType: string }>;
      }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.attachments).toHaveLength(1);
    expect(userMsg!.attachments[0].filename).toBe("att.png");

    // Assistant row has an empty attachments array (never links).
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.attachments).toEqual([]);
  });
});
