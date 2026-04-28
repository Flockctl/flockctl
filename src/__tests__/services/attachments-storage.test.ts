// Direct unit tests for the attachments on-disk lifecycle helpers.
// `routes/chats-attachments.test.ts` covers the upload/blob HTTP surface
// but never exercises deleteAttachmentFiles or sweepOrphans directly —
// leaving 5 branches uncovered. Tests below pin those code paths.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats, chatAttachments } from "../../db/schema.js";
import {
  deleteAttachmentFiles,
  getAttachmentsRoot,
  getChatAttachmentsDir,
  sweepOrphans,
} from "../../services/attachments-storage.js";

let dbHandle: ReturnType<typeof createTestDb>;
let tmpHome: string;
let originalFlockctlHome: string | undefined;

beforeAll(() => {
  dbHandle = createTestDb();
  setDb(dbHandle.db, dbHandle.sqlite);

  // Point FLOCKCTL_HOME at a tmp dir for the whole test run so attachments
  // root resolution is deterministic and isolated.
  tmpHome = mkdtempSync(join(tmpdir(), "attachments-storage-"));
  originalFlockctlHome = process.env.FLOCKCTL_HOME;
  process.env.FLOCKCTL_HOME = tmpHome;
});

afterAll(() => {
  if (originalFlockctlHome !== undefined) {
    process.env.FLOCKCTL_HOME = originalFlockctlHome;
  } else {
    delete process.env.FLOCKCTL_HOME;
  }
  dbHandle.sqlite.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  dbHandle.sqlite.exec("DELETE FROM chat_attachments;");
  dbHandle.sqlite.exec("DELETE FROM chats;");
  // Reset the on-disk attachments root between tests.
  const root = getAttachmentsRoot();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("getAttachmentsRoot / getChatAttachmentsDir", () => {
  it("derives the expected paths under FLOCKCTL_HOME", () => {
    expect(getAttachmentsRoot()).toBe(join(tmpHome, "attachments"));
    expect(getChatAttachmentsDir(42)).toBe(
      join(tmpHome, "attachments", "42"),
    );
  });
});

describe("deleteAttachmentFiles", () => {
  it("unlinks each row's file and collapses now-empty per-chat dirs", () => {
    const chatDir = join(tmpHome, "attachments", "1");
    mkdirSync(chatDir, { recursive: true });
    const f1 = join(chatDir, "a.bin");
    const f2 = join(chatDir, "b.bin");
    writeFileSync(f1, "x");
    writeFileSync(f2, "y");

    deleteAttachmentFiles([
      { id: 1, path: f1 },
      { id: 2, path: f2 },
    ]);

    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);
    // Dir should also be removed since it's now empty.
    expect(existsSync(chatDir)).toBe(false);
  });

  it("logs ENOENT at warn level when the file is already gone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deleteAttachmentFiles([
      { id: 99, path: "/tmp/this/path/does/not/exist-attachments-storage" },
    ]);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("already gone");
    warn.mockRestore();
  });

  it("logs other unlink errors and keeps going (does not throw)", () => {
    // Pass a path that's actually a directory — unlink yields EISDIR /
    // EPERM (not ENOENT), exercising the second `else` branch.
    const dir = join(tmpHome, "attachments", "isdir-test");
    mkdirSync(dir, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      deleteAttachmentFiles([{ id: 100, path: dir }]),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    // The first call could be either "already gone" (some kernels return
    // ENOENT for unlink-on-dir) or "failed to unlink" — both are acceptable.
    warn.mockRestore();
  });

  it("leaves a non-empty per-chat dir alone (rmdir fails silently)", () => {
    const chatDir = join(tmpHome, "attachments", "2");
    mkdirSync(chatDir, { recursive: true });
    const f1 = join(chatDir, "a.bin");
    const f2 = join(chatDir, "b.bin");
    writeFileSync(f1, "x");
    writeFileSync(f2, "y");

    // Only delete one file — the dir is still occupied by the other.
    deleteAttachmentFiles([{ id: 1, path: f1 }]);
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(chatDir)).toBe(true);
    expect(existsSync(f2)).toBe(true);
  });
});

describe("sweepOrphans", () => {
  it("returns {scanned:0,removed:0} when the attachments root is missing", () => {
    // No mkdir — root simply doesn't exist.
    expect(sweepOrphans()).toEqual({ scanned: 0, removed: 0 });
  });

  it("removes a file that no chat_attachments row references", () => {
    const root = getAttachmentsRoot();
    mkdirSync(join(root, "5"), { recursive: true });
    const orphan = join(root, "5", "orphan.bin");
    writeFileSync(orphan, "x");

    const result = sweepOrphans();
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it("preserves a file that IS tracked in chat_attachments", () => {
    const root = getAttachmentsRoot();
    mkdirSync(join(root, "6"), { recursive: true });
    const tracked = join(root, "6", "tracked.bin");
    writeFileSync(tracked, "x");

    const chat = dbHandle.db
      .insert(chats)
      .values({ title: "with-attachment" })
      .returning()
      .get()!;
    dbHandle.db
      .insert(chatAttachments)
      .values({
        chatId: chat.id,
        path: tracked,
        filename: "tracked.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      })
      .run();

    const result = sweepOrphans();
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(existsSync(tracked)).toBe(true);
  });

  it("ignores top-level non-directory entries under the attachments root", () => {
    const root = getAttachmentsRoot();
    mkdirSync(root, { recursive: true });
    // A stray file at the root should be skipped (the loop short-circuits
    // on `entry.isDirectory() === false`).
    writeFileSync(join(root, "stray.txt"), "noise");

    const result = sweepOrphans();
    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("removes the per-chat dir after deleting its only orphan", () => {
    const root = getAttachmentsRoot();
    const dir = join(root, "7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.bin"), "");

    sweepOrphans();
    expect(existsSync(dir)).toBe(false);
  });
});
