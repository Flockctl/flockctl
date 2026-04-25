/**
 * Branch-coverage extras for `services/secrets.ts`.
 *
 * Fills:
 *   - secret.key exists but is wrong size → throws
 *   - decryptValue payload too short → throws
 *   - validateName: long (>128), non-string, invalid-regex
 *   - validateScope: global with non-null scopeId; workspace/project with null scopeId; invalid scope
 *   - upsertSecret: value not string; workspace not found; project not found
 *   - resolveSecretForWorkspace: workspace row missing secret → falls through to global
 *   - substitutePlaceholders: missing-list dedup via two identical missing refs
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
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
  tmpHome = join(tmpdir(), `flockctl-test-secrets-branches-${process.pid}`);
  mkdirSync(tmpHome, { recursive: true });
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

beforeEach(async () => {
  db.delete(secrets).run();
  db.delete(projects).run();
  db.delete(workspaces).run();
  const mod = await import("../../services/secrets.js");
  mod._resetMasterKeyCache();
  // wipe secret.key between tests
  try {
    rmSync(join(tmpHome, "secret.key"), { force: true });
  } catch {}
});

import {
  upsertSecret,
  resolveSecretValue,
  resolveSecretForWorkspace,
  substitutePlaceholders,
} from "../../services/secrets.js";

describe("secrets — master key guard", () => {
  it("throws when existing secret.key is not 32 bytes", async () => {
    // Write a short key (8 bytes base64-encoded)
    writeFileSync(join(tmpHome, "secret.key"), Buffer.from("shortkey").toString("base64") + "\n");
    expect(() =>
      upsertSecret({ scope: "global", scopeId: null, name: "X", value: "v" }),
    ).toThrow(/not 32 bytes/);
  });
});

describe("secrets — validation", () => {
  it("validateName rejects non-string", () => {
    expect(() =>
      upsertSecret({ scope: "global", scopeId: null, name: null as unknown as string, value: "v" }),
    ).toThrow(/name is required/);
  });

  it("validateName rejects empty string", () => {
    expect(() =>
      upsertSecret({ scope: "global", scopeId: null, name: "", value: "v" }),
    ).toThrow(/name is required/);
  });

  it("validateName rejects invalid regex", () => {
    expect(() =>
      upsertSecret({ scope: "global", scopeId: null, name: "1bad", value: "v" }),
    ).toThrow(/name must match/);
  });

  it("validateName rejects over-long names", () => {
    const longName = "A" + "x".repeat(200);
    expect(() =>
      upsertSecret({ scope: "global", scopeId: null, name: longName, value: "v" }),
    ).toThrow(/too long/);
  });

  it("validateScope rejects global + non-null scopeId", () => {
    expect(() =>
      upsertSecret({ scope: "global", scopeId: 1, name: "X", value: "v" }),
    ).toThrow(/global secrets must have scopeId=null/);
  });

  it("validateScope rejects workspace without scopeId", () => {
    expect(() =>
      upsertSecret({ scope: "workspace", scopeId: null, name: "X", value: "v" }),
    ).toThrow(/workspace secrets require a numeric scopeId/);
  });

  it("validateScope rejects project without scopeId", () => {
    expect(() =>
      upsertSecret({ scope: "project", scopeId: null, name: "X", value: "v" }),
    ).toThrow(/project secrets require a numeric scopeId/);
  });

  it("validateScope rejects unknown scope", () => {
    expect(() =>
      // @ts-expect-error intentional invalid scope
      upsertSecret({ scope: "nebula", scopeId: null, name: "X", value: "v" }),
    ).toThrow(/invalid scope/);
  });

  it("upsertSecret rejects non-string value", () => {
    expect(() =>
      upsertSecret({
        scope: "global",
        scopeId: null,
        name: "X",
        value: 123 as unknown as string,
      }),
    ).toThrow(/value must be a string/);
  });

  it("upsertSecret throws when workspace not found", () => {
    expect(() =>
      upsertSecret({ scope: "workspace", scopeId: 999999, name: "X", value: "v" }),
    ).toThrow(/workspace 999999 not found/);
  });

  it("upsertSecret throws when project not found", () => {
    expect(() =>
      upsertSecret({ scope: "project", scopeId: 999999, name: "X", value: "v" }),
    ).toThrow(/project 999999 not found/);
  });
});

describe("secrets — decryptValue too-short payload", () => {
  it("throws when the stored ciphertext is shorter than iv+tag", () => {
    // First, force master key creation so decryption can start.
    upsertSecret({ scope: "global", scopeId: null, name: "SEED", value: "v" });
    // Insert a corrupt global secret with a base64 payload shorter than 12+16 bytes.
    sqlite
      .prepare(
        "INSERT INTO secrets (scope, scope_id, name, value_encrypted) VALUES ('global', NULL, 'CORRUPT', ?)",
      )
      .run(Buffer.from("too-short").toString("base64"));
    expect(() => resolveSecretValue("CORRUPT", null)).toThrow(/secret payload too short/);
  });
});

describe("secrets — resolution fallthrough branches", () => {
  it("resolveSecretForWorkspace: workspaceId set, no ws-row match, falls through to global", () => {
    const ws = db
      .insert(workspaces)
      .values({ name: "wfall", path: "/tmp/wfall" })
      .returning()
      .get()!;
    upsertSecret({ scope: "global", scopeId: null, name: "GKEY", value: "g-val" });
    const result = resolveSecretForWorkspace("GKEY", ws.id);
    expect(result).toBe("g-val");
  });

  it("resolveSecretForWorkspace with null workspaceId & no global → null", () => {
    expect(resolveSecretForWorkspace("NOTHERE", null)).toBeNull();
  });

  it("resolveSecretValue: projectId set but no project row → workspaceId stays null, falls to global", () => {
    upsertSecret({ scope: "global", scopeId: null, name: "FG", value: "fg" });
    // projectId refers to non-existent project → project? is undefined → workspaceId=null
    const result = resolveSecretValue("FG", 987654321);
    expect(result).toBe("fg");
  });
});

describe("secrets — substitutePlaceholders dedup", () => {
  it("deduplicates missing placeholder names", () => {
    const result = substitutePlaceholders("${secret:MISS}-${secret:MISS}", () => null);
    expect(result.missing).toEqual(["MISS"]);
  });
});
