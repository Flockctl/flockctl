import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, secrets } from "../../db/schema.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpHome: string;

vi.mock("../../config", () => ({
  getFlockctlHome: () => tmpHome,
}));

beforeAll(() => {
  tmpHome = join(tmpdir(), `flockctl-test-secrets-${process.pid}`);
  mkdirSync(tmpHome, { recursive: true });
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  db.delete(secrets).run();
  db.delete(projects).run();
  db.delete(workspaces).run();
  const mod = await import("../../services/secrets.js");
  mod._resetMasterKeyCache();
});

import {
  upsertSecret,
  listSecrets,
  deleteSecret,
  deleteSecretsForScope,
  resolveSecretValue,
  resolveSecretForWorkspace,
  substitutePlaceholders,
  listPlaceholders,
} from "../../services/secrets.js";

describe("secrets service", () => {
  describe("master key", () => {
    it("creates secret.key with 0600 permissions on first use", () => {
      const wsId = db.insert(workspaces).values({ name: "ws", path: "/tmp/ws-key" }).returning().get().id;
      upsertSecret({ scope: "workspace", scopeId: wsId, name: "T", value: "v" });
      const keyPath = join(tmpHome, "secret.key");
      expect(existsSync(keyPath)).toBe(true);
      const mode = statSync(keyPath).mode & 0o777;
      // Windows may not honor chmod; skip strict check there
      if (process.platform !== "win32") {
        expect(mode & 0o077).toBe(0);
      }
    });
  });

  describe("validation", () => {
    it("rejects names that aren't identifier-like", () => {
      expect(() => upsertSecret({ scope: "global", scopeId: null, name: "1bad", value: "v" })).toThrow();
      expect(() => upsertSecret({ scope: "global", scopeId: null, name: "with-dash", value: "v" })).toThrow();
      expect(() => upsertSecret({ scope: "global", scopeId: null, name: "", value: "v" })).toThrow();
    });
    it("rejects global secret with scopeId", () => {
      expect(() => upsertSecret({ scope: "global", scopeId: 1, name: "X", value: "v" })).toThrow();
    });
    it("rejects workspace/project secret without scopeId", () => {
      expect(() => upsertSecret({ scope: "workspace", scopeId: null, name: "X", value: "v" })).toThrow();
      expect(() => upsertSecret({ scope: "project", scopeId: null, name: "X", value: "v" })).toThrow();
    });
    it("rejects workspace/project secret for nonexistent scope", () => {
      expect(() => upsertSecret({ scope: "workspace", scopeId: 9999, name: "X", value: "v" })).toThrow();
    });
  });

  describe("round-trip encryption", () => {
    it("stores ciphertext and decrypts back on resolve", () => {
      upsertSecret({ scope: "global", scopeId: null, name: "API_KEY", value: "plain-value" });
      const row = db.select().from(secrets).all()[0];
      expect(row.valueEncrypted).not.toBe("plain-value");
      expect(row.valueEncrypted.length).toBeGreaterThan(20);
      expect(resolveSecretValue("API_KEY", null)).toBe("plain-value");
    });

    it("updates value on repeat upsert", () => {
      upsertSecret({ scope: "global", scopeId: null, name: "K", value: "one" });
      upsertSecret({ scope: "global", scopeId: null, name: "K", value: "two" });
      expect(db.select().from(secrets).all().length).toBe(1);
      expect(resolveSecretValue("K", null)).toBe("two");
    });
  });

  describe("listSecrets", () => {
    it("never returns the encrypted value", () => {
      upsertSecret({ scope: "global", scopeId: null, name: "X", value: "v", description: "d" });
      const list = listSecrets("global", null);
      expect(list.length).toBe(1);
      expect(list[0]).toEqual(expect.objectContaining({ name: "X", description: "d", scope: "global" }));
      expect((list[0] as any).value).toBeUndefined();
      expect((list[0] as any).valueEncrypted).toBeUndefined();
    });

    it("returns items sorted by name", () => {
      upsertSecret({ scope: "global", scopeId: null, name: "B", value: "v" });
      upsertSecret({ scope: "global", scopeId: null, name: "A", value: "v" });
      expect(listSecrets("global", null).map(s => s.name)).toEqual(["A", "B"]);
    });
  });

  describe("scope resolution chain", () => {
    it("project wins over workspace wins over global", () => {
      const ws = db.insert(workspaces).values({ name: "ws1", path: "/tmp/ws1" }).returning().get();
      const p = db.insert(projects).values({ workspaceId: ws.id, name: "p", path: "/tmp/ws1/p" }).returning().get();

      upsertSecret({ scope: "global", scopeId: null, name: "TOKEN", value: "global-val" });
      expect(resolveSecretValue("TOKEN", p.id)).toBe("global-val");

      upsertSecret({ scope: "workspace", scopeId: ws.id, name: "TOKEN", value: "ws-val" });
      expect(resolveSecretValue("TOKEN", p.id)).toBe("ws-val");

      upsertSecret({ scope: "project", scopeId: p.id, name: "TOKEN", value: "p-val" });
      expect(resolveSecretValue("TOKEN", p.id)).toBe("p-val");
    });

    it("returns null when name is nowhere", () => {
      expect(resolveSecretValue("NOPE", null)).toBeNull();
    });

    it("resolveSecretForWorkspace falls back to global", () => {
      const ws = db.insert(workspaces).values({ name: "wsX", path: "/tmp/wsX" }).returning().get();
      upsertSecret({ scope: "global", scopeId: null, name: "G", value: "g-val" });
      expect(resolveSecretForWorkspace("G", ws.id)).toBe("g-val");
      upsertSecret({ scope: "workspace", scopeId: ws.id, name: "G", value: "w-val" });
      expect(resolveSecretForWorkspace("G", ws.id)).toBe("w-val");
    });
  });

  describe("deletion", () => {
    it("deleteSecret removes a specific row", () => {
      upsertSecret({ scope: "global", scopeId: null, name: "X", value: "v" });
      expect(deleteSecret("global", null, "X")).toBe(true);
      expect(deleteSecret("global", null, "X")).toBe(false);
      expect(listSecrets("global", null)).toEqual([]);
    });

    it("deleteSecretsForScope wipes everything in a workspace/project", () => {
      const ws = db.insert(workspaces).values({ name: "ws2", path: "/tmp/ws2" }).returning().get();
      upsertSecret({ scope: "workspace", scopeId: ws.id, name: "A", value: "a" });
      upsertSecret({ scope: "workspace", scopeId: ws.id, name: "B", value: "b" });
      upsertSecret({ scope: "global", scopeId: null, name: "C", value: "c" });

      deleteSecretsForScope("workspace", ws.id);
      expect(listSecrets("workspace", ws.id)).toEqual([]);
      expect(listSecrets("global", null).map(s => s.name)).toEqual(["C"]);
    });
  });
});

describe("placeholder utilities", () => {
  it("substitutePlaceholders replaces every match and reports missing", () => {
    const res = substitutePlaceholders("a=${secret:A} b=${secret:MISSING}", (name) => {
      if (name === "A") return "AAA";
      return null;
    });
    expect(res.value).toBe("a=AAA b=${secret:MISSING}");
    expect(res.missing).toEqual(["MISSING"]);
  });

  it("substitutePlaceholders is a no-op for strings without placeholders", () => {
    const res = substitutePlaceholders("plain-text", () => "ignored");
    expect(res.value).toBe("plain-text");
    expect(res.missing).toEqual([]);
  });

  it("listPlaceholders deduplicates names", () => {
    expect(listPlaceholders("${secret:X}-${secret:Y}-${secret:X}")).toEqual(["X", "Y"]);
  });

  it("ignores malformed placeholder syntax", () => {
    expect(listPlaceholders("${secret:}")).toEqual([]);
    expect(listPlaceholders("${NOPE:X}")).toEqual([]);
  });
});
