/**
 * Branch-coverage tests for `services/attachments.ts` at the module level
 * (the route-level tests exercise the happy path over HTTP, but miss the
 * validation guards in saveAttachment / validateAttachmentsForMessage).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { chats, chatAttachments } from "../../db/schema.js";
import {
  saveAttachment,
  validateAttachmentsForMessage,
  AttachmentError,
} from "../../services/attachments.js";

// Minimal 1x1 PNG bytes — enough for the sniff to pass the "image" branch.
const PNG_1x1 = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63FCCFC0500F000313010111CE3B6D30000000049454E44AE426082",
  "hex",
);

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpFlockHome: string;
let origHome: string | undefined;

beforeAll(() => {
  tmpFlockHome = mkdtempSync(join(tmpdir(), "flockctl-attach-branches-"));
  origHome = process.env.FLOCKCTL_HOME;
  process.env.FLOCKCTL_HOME = tmpFlockHome;
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  if (origHome !== undefined) process.env.FLOCKCTL_HOME = origHome;
  else delete process.env.FLOCKCTL_HOME;
  try {
    sqlite.close();
  } catch {}
  try {
    rmSync(tmpFlockHome, { recursive: true, force: true });
  } catch {}
});

function newChatId(): number {
  const row = db
    .insert(chats)
    .values({ projectId: null, title: "t" })
    .returning()
    .get()!;
  return row.id;
}

describe("saveAttachment — validation branches", () => {
  it("rejects null file payload", () => {
    const chatId = newChatId();
    expect(() =>
      saveAttachment({
        chatId,
        // @ts-expect-error — exercising the !file guard
        file: null,
      }),
    ).toThrow(AttachmentError);
  });

  it("rejects non-Buffer bytes (covers !Buffer.isBuffer guard)", () => {
    const chatId = newChatId();
    expect(() =>
      saveAttachment({
        chatId,
        file: {
          // @ts-expect-error — intentionally wrong type
          bytes: "not-a-buffer",
          filename: "x.png",
          mimeType: "image/png",
        },
      }),
    ).toThrow(/empty/);
  });

  it("rejects empty buffer", () => {
    const chatId = newChatId();
    expect(() =>
      saveAttachment({
        chatId,
        file: { bytes: Buffer.alloc(0), filename: "x.png", mimeType: "image/png" },
      }),
    ).toThrow(/empty/);
  });

  it("rejects oversize payload (covers MAX_ATTACHMENT_BYTES branch)", () => {
    const chatId = newChatId();
    // 31 MiB > the 30 MB cap in attachments-types.ts.
    const huge = Buffer.alloc(31 * 1024 * 1024, 0);
    expect(() =>
      saveAttachment({
        chatId,
        file: { bytes: huge, filename: "x.bin", mimeType: "application/octet-stream" },
      }),
    ).toThrow(/exceeds/);
  });

  it("accepts a real PNG with no mimeType provided (covers file.mimeType ?? '')", () => {
    const chatId = newChatId();
    const row = saveAttachment({
      chatId,
      // mimeType is declared required, but the implementation defensively
      // applies `file.mimeType ?? ""` — cast to exercise the fallback branch.
      file: { bytes: PNG_1x1, filename: "p.png" } as unknown as {
        bytes: Buffer;
        filename: string;
        mimeType: string;
      },
    });
    expect(row.mimeType).toBe("image/png");
  });

  it("rejects declared PDF whose bytes are actually PNG (covers PDF-mismatch branch)", () => {
    const chatId = newChatId();
    expect(() =>
      saveAttachment({
        chatId,
        file: { bytes: PNG_1x1, filename: "sneaky.pdf", mimeType: "application/pdf" },
      }),
    ).toThrow(/does not match/);
  });

  it("accepts 'image/jpg' alias when bytes are JPEG (covers the jpg/jpeg alias branch)", () => {
    // Minimal 1x1 JPEG: SOI + minimal JFIF + EOI. Keep large enough that
    // the sniff actually classifies as image/jpeg.
    const jpgHex =
      "FFD8FFE000104A46494600010100000100010000" +
      "FFDB004300080606070605080707070909080A0C140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F27393D38323C2E333432" +
      "FFC0000B080001000101011100" +
      "FFC4001F0000010501010101010100000000000000000102030405060708090A0B" +
      "FFC40014000100000000000000000000000000000000" +
      "FFDA0008010100003F00" +
      "FFD9";
    const chatId = newChatId();
    const row = saveAttachment({
      chatId,
      file: {
        bytes: Buffer.from(jpgHex, "hex"),
        filename: "photo.jpg",
        // Browsers sometimes use the non-canonical "image/jpg" — accept it.
        mimeType: "image/jpg",
      },
    });
    expect(row.mimeType).toBe("image/jpeg");
  });
});

describe("validateAttachmentsForMessage — branches", () => {
  it("empty list short-circuits with []", () => {
    expect(validateAttachmentsForMessage(1, [])).toEqual([]);
  });

  it("rejects when count exceeds MAX_ATTACHMENTS_PER_MESSAGE", () => {
    const chatId = newChatId();
    // Fabricate a list of 100 ids — the length check precedes any DB fetch.
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() => validateAttachmentsForMessage(chatId, ids)).toThrow(
      /too many attachments/,
    );
  });
});
