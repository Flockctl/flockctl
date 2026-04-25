import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the singleton lazy init path in src/db/index.ts by overriding
// getFlockctlHome to a scratch dir. Requires isolateModules per test so the
// module-level `_db` cache doesn't leak across cases.

let scratchDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "flockctl-db-idx-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of scratchDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  scratchDirs = [];
  vi.resetModules();
});

describe("db/index singleton", () => {
  it("getDb creates file under flockctl home and enables WAL + FKs", async () => {
    const home = freshHome();
    vi.doMock("../config/index.js", () => ({ getFlockctlHome: () => home }));
    vi.doMock("../config", () => ({ getFlockctlHome: () => home }));

    const mod = await import("../db/index.js");
    const db = mod.getDb();
    expect(db).toBeTruthy();

    const sqlite = mod.getRawDb();
    const journal = sqlite.pragma("journal_mode", { simple: true });
    const fks = sqlite.pragma("foreign_keys", { simple: true });
    expect(String(journal).toLowerCase()).toBe("wal");
    expect(Number(fks)).toBe(1);

    mod.closeDb();
  });

  it("getDb is idempotent — returns the same instance", async () => {
    const home = freshHome();
    vi.doMock("../config/index.js", () => ({ getFlockctlHome: () => home }));
    vi.doMock("../config", () => ({ getFlockctlHome: () => home }));

    const mod = await import("../db/index.js");
    const a = mod.getDb();
    const b = mod.getDb();
    expect(a).toBe(b);
    mod.closeDb();
  });

  it("getRawDb lazily initializes when called first", async () => {
    const home = freshHome();
    vi.doMock("../config/index.js", () => ({ getFlockctlHome: () => home }));
    vi.doMock("../config", () => ({ getFlockctlHome: () => home }));

    const mod = await import("../db/index.js");
    const raw = mod.getRawDb();
    expect(typeof raw.prepare).toBe("function");
    mod.closeDb();
  });

  it("setDb overrides the singleton", async () => {
    const home = freshHome();
    vi.doMock("../config/index.js", () => ({ getFlockctlHome: () => home }));
    vi.doMock("../config", () => ({ getFlockctlHome: () => home }));

    const mod = await import("../db/index.js");
    const helpersMod = await import("./helpers.js");
    const t = helpersMod.createTestDb();

    mod.setDb(t.db, t.sqlite);
    expect(mod.getDb()).toBe(t.db);
    expect(mod.getRawDb()).toBe(t.sqlite);

    // setDb with no sqlite clears the raw handle.
    mod.setDb(t.db);
    // After this, getRawDb would reinitialize from disk — exercise guarding branch.
    // Close the test DB to avoid leaking.
    t.sqlite.close();
  });

  it("closeDb is safe to call twice", async () => {
    const home = freshHome();
    vi.doMock("../config/index.js", () => ({ getFlockctlHome: () => home }));
    vi.doMock("../config", () => ({ getFlockctlHome: () => home }));

    const mod = await import("../db/index.js");
    mod.getDb();
    mod.closeDb();
    expect(() => mod.closeDb()).not.toThrow();
  });
});
