import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { aiProviderKeys, projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";
import { selectKeyForTask, seedDefaultKey } from "../../services/ai/key-selection.js";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => sqlite.close());

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM ai_provider_keys;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
});

describe("seedDefaultKey", () => {
  it("inserts the default Claude CLI key when table is empty", () => {
    seedDefaultKey();
    const keys = db.select().from(aiProviderKeys).all();
    expect(keys.length).toBe(1);
    expect(keys[0].provider).toBe("claude_cli");
    expect(keys[0].providerType).toBe("cli");
    expect(keys[0].cliCommand).toBe("claude");
    expect(keys[0].configDir).toBeNull();
  });

  it("is a no-op when at least one key exists", () => {
    db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "anthropic-messages",
      label: "existing",
      keyValue: "sk-ant-api-x",
      isActive: true,
      priority: 0,
    }).run();

    seedDefaultKey();
    const keys = db.select().from(aiProviderKeys).all();
    expect(keys.length).toBe(1); // still only the anthropic key
  });
});

describe("selectKeyForTask — allowedKeyIds inheritance", () => {
  it("falls back to project-level allowedKeyIds when task has none", async () => {
    const k1 = db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).returning().get()!;
    const k2 = db.insert(aiProviderKeys).values({
      provider: "b", providerType: "anthropic-messages",
      label: "B", keyValue: "kB", isActive: true, priority: 1,
    }).returning().get()!;

    const proj = db.insert(projects).values({
      name: "p", allowedKeyIds: JSON.stringify([k2.id]),
    }).returning().get()!;

    const selected = await selectKeyForTask({ projectId: proj.id });
    expect(selected.id).toBe(k2.id);
    // ensure we got B despite A having higher priority
    expect(selected.provider).toBe("b");
    // reference k1 to avoid unused
    expect(k1.id).not.toBe(k2.id);
  });

  it("falls back to workspace-level allowedKeyIds when project has none", async () => {
    const k1 = db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).returning().get()!;
    const k2 = db.insert(aiProviderKeys).values({
      provider: "b", providerType: "anthropic-messages",
      label: "B", keyValue: "kB", isActive: true, priority: 1,
    }).returning().get()!;

    const ws = db.insert(workspaces).values({
      name: "w", path: "/tmp/ws-keysel", allowedKeyIds: JSON.stringify([k2.id]),
    }).returning().get()!;
    const proj = db.insert(projects).values({
      name: "p", workspaceId: ws.id,
    }).returning().get()!;

    const selected = await selectKeyForTask({ projectId: proj.id });
    expect(selected.id).toBe(k2.id);
    expect(k1.id).not.toBe(k2.id);
  });

  it("returns empty allowed when project has no workspace and no allowedKeyIds", async () => {
    db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).run();

    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const selected = await selectKeyForTask({ projectId: proj.id });
    // Without allow-list, first active key is selected
    expect(selected.provider).toBe("a");
  });

  it("handles missing project gracefully", async () => {
    db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).run();

    // projectId that does not exist — resolveAllowedKeyIds returns []
    const selected = await selectKeyForTask({ projectId: 999999 });
    expect(selected.provider).toBe("a");
  });

  it("handles malformed JSON in allowedKeyIds", async () => {
    db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).run();

    // safeParseJsonArray should return [] on parse error,
    // allowing fall-through to no restriction
    const selected = await selectKeyForTask({ allowedKeyIds: "not-json{" });
    expect(selected.provider).toBe("a");
  });

  it("assignedKeyId takes precedence even if missing from table", async () => {
    const real = db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).returning().get()!;

    // Assigned ID that doesn't exist → falls through to first-candidate selection
    const fallback = await selectKeyForTask({ assignedKeyId: 9999 });
    expect(fallback.id).toBe(real.id);

    // Real assigned ID → returned directly even with priority
    const direct = await selectKeyForTask({ assignedKeyId: real.id });
    expect(direct.id).toBe(real.id);
  });

  it("skips excluded key ids and picks the next candidate", async () => {
    const primary = db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).returning().get()!;
    const secondary = db.insert(aiProviderKeys).values({
      provider: "b", providerType: "anthropic-messages",
      label: "B", keyValue: "kB", isActive: true, priority: 1,
    }).returning().get()!;

    const selected = await selectKeyForTask({}, { excludeKeyIds: [primary.id] });
    expect(selected.id).toBe(secondary.id);
  });

  it("treats assignedKeyId as unavailable when excluded", async () => {
    const assigned = db.insert(aiProviderKeys).values({
      provider: "a", providerType: "anthropic-messages",
      label: "A", keyValue: "kA", isActive: true, priority: 0,
    }).returning().get()!;

    await expect(
      selectKeyForTask({ assignedKeyId: assigned.id }, { excludeKeyIds: [assigned.id] }),
    ).rejects.toThrow("No available AI keys");
  });
});
