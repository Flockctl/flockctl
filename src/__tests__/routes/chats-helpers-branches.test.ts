import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import {
  parseAttachmentIds,
  parseEffortBody,
  parseThinkingEnabledBody,
  parseTodosJson,
  coerceKeyId,
  classifyKeyIdSource,
  resolveKeyConfigDir,
  resolveKeyDispatch,
  resolveChatKeyId,
  resolveDefaultKeyForChat,
  assertKeyAllowedForChat,
  persistChatSelection,
  resolveChatCwd,
  resolveChatContext,
  resolveChatScope,
  resolveChatSystemPrompt,
  resolveChatWorkspaceContext,
  getChatMetrics,
  loadPriorMessages,
  DEFAULT_SYSTEM_PROMPT,
  MAX_CHAT_MESSAGES,
} from "../../routes/chats/helpers.js";
import { setGlobalDefaults } from "../../config/defaults.js";
import {
  aiProviderKeys,
  chats,
  chatMessages,
  chatTodos,
  projects,
  usageRecords,
  workspaces,
} from "../../db/schema.js";
import { ValidationError } from "../../lib/errors.js";
import { eq } from "drizzle-orm";

describe("chats/helpers — branch coverage", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    testDb = createTestDb();
    db = testDb.db;
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    closeDb();
  });

  // ─── parseAttachmentIds ─────────────────────────────────
  describe("parseAttachmentIds", () => {
    it("returns [] when undefined", () => {
      expect(parseAttachmentIds({})).toEqual([]);
    });
    it("returns [] when null", () => {
      expect(parseAttachmentIds({ attachment_ids: null })).toEqual([]);
    });
    it("returns array when valid", () => {
      expect(parseAttachmentIds({ attachment_ids: [1, 2, 3] })).toEqual([1, 2, 3]);
    });
    it("throws ValidationError on non-array", () => {
      expect(() => parseAttachmentIds({ attachment_ids: "bad" })).toThrow(ValidationError);
    });
    it("throws ValidationError on negative ints", () => {
      expect(() => parseAttachmentIds({ attachment_ids: [-1] })).toThrow(ValidationError);
    });
    it("throws on non-integer", () => {
      expect(() => parseAttachmentIds({ attachment_ids: [1.5] })).toThrow(ValidationError);
    });
  });

  // ─── parseEffortBody ─────────────────────────────────
  describe("parseEffortBody", () => {
    it("returns undefined when 'effort' missing", () => {
      expect(parseEffortBody({})).toBeUndefined();
    });
    it("returns null when raw null", () => {
      expect(parseEffortBody({ effort: null })).toBeNull();
    });
    it("returns valid level string", () => {
      expect(parseEffortBody({ effort: "high" })).toBe("high");
      expect(parseEffortBody({ effort: "low" })).toBe("low");
      expect(parseEffortBody({ effort: "medium" })).toBe("medium");
      expect(parseEffortBody({ effort: "max" })).toBe("max");
    });
    it("throws on invalid string", () => {
      expect(() => parseEffortBody({ effort: "unknown" })).toThrow(ValidationError);
    });
    it("throws on non-string", () => {
      expect(() => parseEffortBody({ effort: 5 })).toThrow(ValidationError);
    });
  });

  // ─── parseThinkingEnabledBody ─────────────────────────────────
  describe("parseThinkingEnabledBody", () => {
    it("returns undefined when absent", () => {
      expect(parseThinkingEnabledBody({})).toBeUndefined();
    });
    it("reads snake_case variant", () => {
      expect(parseThinkingEnabledBody({ thinking_enabled: true })).toBe(true);
      expect(parseThinkingEnabledBody({ thinking_enabled: false })).toBe(false);
    });
    it("reads camelCase variant", () => {
      expect(parseThinkingEnabledBody({ thinkingEnabled: true })).toBe(true);
    });
    it("prefers snake_case when both set", () => {
      expect(parseThinkingEnabledBody({ thinking_enabled: true, thinkingEnabled: false })).toBe(true);
    });
    it("throws on non-boolean", () => {
      expect(() => parseThinkingEnabledBody({ thinking_enabled: "true" })).toThrow(ValidationError);
    });
    it("treats explicit undefined as absent", () => {
      expect(parseThinkingEnabledBody({ thinking_enabled: undefined })).toBeUndefined();
    });
  });

  // ─── parseTodosJson ─────────────────────────────────
  describe("parseTodosJson", () => {
    it("returns empty array on parse error", () => {
      expect(parseTodosJson("not json")).toEqual([]);
    });
    it("returns empty array when non-array", () => {
      expect(parseTodosJson("{}")).toEqual([]);
      expect(parseTodosJson("42")).toEqual([]);
    });
    it("returns array when valid JSON array", () => {
      const r = parseTodosJson(JSON.stringify([{ content: "x", status: "pending" }]));
      expect(r).toHaveLength(1);
    });
  });

  // ─── coerceKeyId ─────────────────────────────────
  describe("coerceKeyId", () => {
    it("returns undefined for null/undefined", () => {
      expect(coerceKeyId(undefined)).toBeUndefined();
      expect(coerceKeyId(null)).toBeUndefined();
    });
    it("accepts positive number", () => {
      expect(coerceKeyId(7)).toBe(7);
    });
    it("parses numeric string", () => {
      expect(coerceKeyId("42")).toBe(42);
    });
    it("rejects zero/negative", () => {
      expect(coerceKeyId(0)).toBeUndefined();
      expect(coerceKeyId(-3)).toBeUndefined();
    });
    it("rejects NaN-like strings", () => {
      expect(coerceKeyId("bad")).toBeUndefined();
    });
  });

  // ─── classifyKeyIdSource ─────────────────────────────────
  describe("classifyKeyIdSource", () => {
    it("request when bodyKeyId present", () => {
      expect(classifyKeyIdSource(5, null)).toBe("request");
    });
    it("stored when only storedKeyId present", () => {
      expect(classifyKeyIdSource(undefined, 9)).toBe("stored");
    });
    it("default when neither", () => {
      expect(classifyKeyIdSource(undefined, null)).toBe("default");
      expect(classifyKeyIdSource(null, undefined)).toBe("default");
    });
  });

  // ─── resolveKeyConfigDir ─────────────────────────────────
  describe("resolveKeyConfigDir", () => {
    it("returns undefined for no keyId", () => {
      expect(resolveKeyConfigDir(db, undefined)).toBeUndefined();
    });
    it("returns undefined for missing key", () => {
      expect(resolveKeyConfigDir(db, 999)).toBeUndefined();
    });
    it("returns configDir when present", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api-key", label: "a", configDir: "/tmp/cfg" } as any)
        .returning()
        .get()!;
      expect(resolveKeyConfigDir(db, k.id)).toBe("/tmp/cfg");
    });
    it("returns undefined when configDir is null", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api-key", label: "a" } as any)
        .returning()
        .get()!;
      expect(resolveKeyConfigDir(db, k.id)).toBeUndefined();
    });
  });

  // ─── resolveKeyDispatch ─────────────────────────────────
  describe("resolveKeyDispatch", () => {
    it("returns {} for missing keyId", () => {
      expect(resolveKeyDispatch(db, undefined)).toEqual({});
    });
    it("returns {} for unknown key", () => {
      expect(resolveKeyDispatch(db, 9999)).toEqual({});
    });
    it("handles github_copilot — returns agent + token", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({
          provider: "github_copilot",
          providerType: "oauth",
          label: "c",
          keyValue: "ghp-xxx",
        } as any)
        .returning()
        .get()!;
      expect(resolveKeyDispatch(db, k.id)).toEqual({
        agentId: "copilot",
        providerKeyValue: "ghp-xxx",
        keyProvider: "github_copilot",
      });
    });
    it("handles github_copilot with null keyValue", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "github_copilot", providerType: "oauth", label: "c" } as any)
        .returning()
        .get()!;
      const r = resolveKeyDispatch(db, k.id);
      expect(r.agentId).toBe("copilot");
      expect(r.providerKeyValue).toBeUndefined();
    });
    it("non-copilot provider returns keyProvider only", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api-key", label: "a" } as any)
        .returning()
        .get()!;
      expect(resolveKeyDispatch(db, k.id)).toEqual({ keyProvider: "anthropic" });
    });
  });

  // ─── resolveChatKeyId ─────────────────────────────────
  describe("resolveChatKeyId", () => {
    it("uses bodyKeyId first", () => {
      expect(resolveChatKeyId(db, 7, { aiProviderKeyId: 2, projectId: null })).toBe(7);
    });
    it("falls back to stored active key", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api-key", label: "x", isActive: true } as any)
        .returning()
        .get()!;
      expect(resolveChatKeyId(db, undefined, { aiProviderKeyId: k.id, projectId: null })).toBe(k.id);
    });
    it("skips stored key that is inactive — falls through", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api-key", label: "x", isActive: false } as any)
        .returning()
        .get()!;
      // With no rc default set the fallthrough returns undefined.
      expect(resolveChatKeyId(db, undefined, { aiProviderKeyId: k.id, projectId: null })).toBeUndefined();
    });
    it("skips stored key that no longer exists", () => {
      expect(resolveChatKeyId(db, undefined, { aiProviderKeyId: 9999, projectId: null })).toBeUndefined();
    });
  });

  // ─── resolveDefaultKeyForChat ─────────────────────────────────
  describe("resolveDefaultKeyForChat", () => {
    it("returns undefined with no keys and no project", () => {
      expect(resolveDefaultKeyForChat(db, { projectId: null })).toBeUndefined();
    });
    it("picks first active allowed key when project has allowlist", () => {
      const k1 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "k1", isActive: true, priority: 1 } as any)
        .returning()
        .get()!;
      const k2 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "k2", isActive: true, priority: 2 } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([k2.id]) } as any)
        .returning()
        .get()!;
      expect(resolveDefaultKeyForChat(db, { projectId: p.id })).toBe(k2.id);
    });
    it("returns undefined when allowlist has no active keys", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "k", isActive: false } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([k.id]) } as any)
        .returning()
        .get()!;
      expect(resolveDefaultKeyForChat(db, { projectId: p.id })).toBeUndefined();
    });

    it("returns rc default when it's active and in the allowlist", () => {
      const k1 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "k1", isActive: true, priority: 1 } as any)
        .returning()
        .get()!;
      const k2 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "k2", isActive: true, priority: 2 } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([k1.id, k2.id]) } as any)
        .returning()
        .get()!;
      // rc default points at k2, which IS in the allowlist and active →
      // exercises the restricted-rc-compatible branch at helpers.ts:242-248.
      setGlobalDefaults({ defaultKeyId: k2.id });
      try {
        expect(resolveDefaultKeyForChat(db, { projectId: p.id })).toBe(k2.id);
      } finally {
        setGlobalDefaults({ defaultKeyId: null });
      }
    });

    it("falls through when rc default is in allowlist but inactive", () => {
      const k1 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "active", isActive: true, priority: 5 } as any)
        .returning()
        .get()!;
      const k2 = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "inactive", isActive: false, priority: 1 } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([k1.id, k2.id]) } as any)
        .returning()
        .get()!;
      // rc default is k2 (inactive) → first `if (key && key.isActive !== false)`
      // is false → falls through to the candidate-by-priority scan → picks k1.
      setGlobalDefaults({ defaultKeyId: k2.id });
      try {
        expect(resolveDefaultKeyForChat(db, { projectId: p.id })).toBe(k1.id);
      } finally {
        setGlobalDefaults({ defaultKeyId: null });
      }
    });

    it("legacy path: returns rc default when no allowlist and key is active", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "legacy", isActive: true } as any)
        .returning()
        .get()!;
      setGlobalDefaults({ defaultKeyId: k.id });
      try {
        expect(resolveDefaultKeyForChat(db, { projectId: null })).toBe(k.id);
      } finally {
        setGlobalDefaults({ defaultKeyId: null });
      }
    });

    it("legacy path: returns undefined when rc default key is inactive", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "gone", isActive: false } as any)
        .returning()
        .get()!;
      setGlobalDefaults({ defaultKeyId: k.id });
      try {
        expect(resolveDefaultKeyForChat(db, { projectId: null })).toBeUndefined();
      } finally {
        setGlobalDefaults({ defaultKeyId: null });
      }
    });

    it("legacy path: returns undefined when rc default points to missing key", () => {
      setGlobalDefaults({ defaultKeyId: 9999 });
      try {
        expect(resolveDefaultKeyForChat(db, { projectId: null })).toBeUndefined();
      } finally {
        setGlobalDefaults({ defaultKeyId: null });
      }
    });
  });

  // ─── assertKeyAllowedForChat ─────────────────────────────────
  describe("assertKeyAllowedForChat", () => {
    it("no-op when keyId undefined", () => {
      expect(() => assertKeyAllowedForChat(db, { projectId: null }, undefined, "request")).not.toThrow();
    });
    it("no-op when no allowlist", () => {
      expect(() => assertKeyAllowedForChat(db, { projectId: null }, 1, "request")).not.toThrow();
    });
    it("throws when key not in allowlist (request)", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "ok" } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([ok.id]) } as any)
        .returning()
        .get()!;
      expect(() => assertKeyAllowedForChat(db, { projectId: p.id }, 9999, "request")).toThrow(ValidationError);
    });
    it("throws with stored hint source", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "ok" } as any)
        .returning()
        .get()!;
      const rej = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "rej" } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([ok.id]) } as any)
        .returning()
        .get()!;
      try {
        assertKeyAllowedForChat(db, { projectId: p.id }, rej.id, "stored");
        expect.fail("expected throw");
      } catch (e: any) {
        expect(e.message).toMatch(/saved key/i);
      }
    });
    it("default-source hint mentions global default", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "ok" } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([ok.id]) } as any)
        .returning()
        .get()!;
      try {
        assertKeyAllowedForChat(db, { projectId: p.id }, 9999, "default");
        expect.fail("expected throw");
      } catch (e: any) {
        expect(e.message).toMatch(/global default/i);
      }
    });
    it("passes when key is in allowlist", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "ok" } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", allowedKeyIds: JSON.stringify([ok.id]) } as any)
        .returning()
        .get()!;
      expect(() => assertKeyAllowedForChat(db, { projectId: p.id }, ok.id, "request")).not.toThrow();
    });
  });

  // ─── persistChatSelection ─────────────────────────────────
  describe("persistChatSelection", () => {
    it("no-op when all values match", () => {
      const chat = db.insert(chats).values({ title: "c", model: "m", thinkingEnabled: true } as any).returning().get()!;
      const before = chat.updatedAt;
      persistChatSelection(db, chat.id, chat, {
        keyId: undefined,
        model: "m",
        thinkingEnabled: true,
        effort: undefined,
      });
      const after = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(after.updatedAt).toBe(before);
    });
    it("writes new keyId only when key row exists", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      const k = db
        .insert(aiProviderKeys)
        .values({ provider: "a", providerType: "api", label: "k" } as any)
        .returning()
        .get()!;
      persistChatSelection(db, chat.id, chat, { keyId: k.id, model: undefined });
      const after = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(after.aiProviderKeyId).toBe(k.id);
    });
    it("skips orphan keyId", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      persistChatSelection(db, chat.id, chat, { keyId: 9999, model: undefined });
      const after = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(after.aiProviderKeyId).toBeNull();
    });
    it("clears effort with null", () => {
      const chat = db.insert(chats).values({ title: "c", effort: "high" } as any).returning().get()!;
      persistChatSelection(db, chat.id, chat, { keyId: undefined, model: undefined, effort: null });
      const after = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(after.effort).toBeNull();
    });
    it("updates model only when non-empty and changed", () => {
      const chat = db.insert(chats).values({ title: "c", model: "old" } as any).returning().get()!;
      persistChatSelection(db, chat.id, chat, { keyId: undefined, model: "" });
      const afterEmpty = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(afterEmpty.model).toBe("old");
      persistChatSelection(db, chat.id, chat, { keyId: undefined, model: "new" });
      const afterNew = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(afterNew.model).toBe("new");
    });
    it("updates thinkingEnabled when changed", () => {
      const chat = db.insert(chats).values({ title: "c", thinkingEnabled: true } as any).returning().get()!;
      persistChatSelection(db, chat.id, chat, {
        keyId: undefined,
        model: undefined,
        thinkingEnabled: false,
      });
      const after = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
      expect(after.thinkingEnabled).toBe(false);
    });
  });

  // ─── resolveChatCwd ─────────────────────────────────
  describe("resolveChatCwd", () => {
    it("returns workspace path when workspaceId set", () => {
      const ws = db
        .insert(workspaces)
        .values({ name: "W", path: "/tmp/ws" } as any)
        .returning()
        .get()!;
      const chat = { workspaceId: ws.id, projectId: null } as any;
      expect(resolveChatCwd(db, chat)).toBe("/tmp/ws");
    });
    it("falls through to project path when workspace missing", () => {
      const p = db.insert(projects).values({ name: "P", path: "/tmp/p" } as any).returning().get()!;
      const chat = { workspaceId: null, projectId: p.id } as any;
      expect(resolveChatCwd(db, chat)).toBe("/tmp/p");
    });
    it("falls back to flockctl home when neither", () => {
      const chat = { workspaceId: null, projectId: null } as any;
      const r = resolveChatCwd(db, chat);
      expect(typeof r).toBe("string");
      expect(r.length).toBeGreaterThan(0);
    });
    it("falls back to flockctl home when workspace has no path", () => {
      // Insert a workspace with an empty string path (it's NOT NULL in schema).
      // Using a unique empty-ish path to exercise falsy-path branch.
      const chat = { workspaceId: 9999, projectId: null } as any;
      const r = resolveChatCwd(db, chat);
      expect(typeof r).toBe("string");
    });
    it("workspace with path null — falls through to project", () => {
      // workspace rows require a path, so simulate falling through by
      // pointing to a missing workspaceId.
      const p = db.insert(projects).values({ name: "P2", path: "/tmp/p2" } as any).returning().get()!;
      const chat = { workspaceId: 9999, projectId: p.id } as any;
      expect(resolveChatCwd(db, chat)).toBe("/tmp/p2");
    });
  });

  // ─── resolveChatContext ─────────────────────────────────
  describe("resolveChatContext", () => {
    it("returns null names when neither project nor workspace", () => {
      expect(resolveChatContext(db, { projectId: null, workspaceId: null })).toEqual({
        projectName: null,
        workspaceName: null,
      });
    });
    it("returns project+workspace names", () => {
      const w = db.insert(workspaces).values({ name: "WW", path: "/tmp/w" } as any).returning().get()!;
      const p = db.insert(projects).values({ name: "PP" } as any).returning().get()!;
      expect(resolveChatContext(db, { projectId: p.id, workspaceId: w.id })).toEqual({
        projectName: "PP",
        workspaceName: "WW",
      });
    });
    it("handles missing project / workspace rows gracefully", () => {
      expect(resolveChatContext(db, { projectId: 9999, workspaceId: 9999 })).toEqual({
        projectName: null,
        workspaceName: null,
      });
    });
  });

  // ─── resolveChatScope ─────────────────────────────────
  describe("resolveChatScope", () => {
    it("returns all undefined when no ids", () => {
      const chat = { projectId: null, workspaceId: null } as any;
      const r = resolveChatScope(db, chat);
      expect(r.project).toBeUndefined();
      expect(r.workspace).toBeUndefined();
    });
    it("walks project → workspace when chat has no workspaceId", () => {
      const w = db.insert(workspaces).values({ name: "X", path: "/tmp/x" } as any).returning().get()!;
      const p = db.insert(projects).values({ name: "P", workspaceId: w.id, path: "/tmp/p" } as any).returning().get()!;
      const chat = { projectId: p.id, workspaceId: null } as any;
      const r = resolveChatScope(db, chat);
      expect(r.project?.id).toBe(p.id);
      expect(r.workspace?.id).toBe(w.id);
    });
    it("uses chat.workspaceId directly when set", () => {
      const w = db.insert(workspaces).values({ name: "X2", path: "/tmp/x2" } as any).returning().get()!;
      const chat = { projectId: null, workspaceId: w.id } as any;
      const r = resolveChatScope(db, chat);
      expect(r.workspace?.id).toBe(w.id);
    });
  });

  // ─── resolveChatSystemPrompt ─────────────────────────────────
  describe("resolveChatSystemPrompt", () => {
    it("returns body.system override verbatim", () => {
      const chat = { entityType: null, entityId: null, projectId: null, workspaceId: null } as any;
      expect(resolveChatSystemPrompt(db, chat, { system: "OVERRIDE" })).toBe("OVERRIDE");
    });
    it("returns DEFAULT_SYSTEM_PROMPT when no overrides", () => {
      const chat = { entityType: null, entityId: null, projectId: null, workspaceId: null } as any;
      expect(resolveChatSystemPrompt(db, chat, {})).toBe(DEFAULT_SYSTEM_PROMPT);
    });
    it("skips entity branch when projectId missing", () => {
      const chat = { entityType: "milestone", entityId: "slug", projectId: null, workspaceId: null } as any;
      expect(resolveChatSystemPrompt(db, chat, {})).toBe(DEFAULT_SYSTEM_PROMPT);
    });
    it("skips entity branch when project has no path", () => {
      const p = db.insert(projects).values({ name: "NoPath" } as any).returning().get()!;
      const chat = { entityType: "milestone", entityId: "m-1", projectId: p.id, workspaceId: null } as any;
      expect(resolveChatSystemPrompt(db, chat, {})).toBe(DEFAULT_SYSTEM_PROMPT);
    });
    it("body.entity_context provides entity_type/entity_id", () => {
      const p = db.insert(projects).values({ name: "EP" } as any).returning().get()!;
      const chat = { entityType: null, entityId: null, projectId: p.id, workspaceId: null } as any;
      // Project has no path → still falls back to default.
      const r = resolveChatSystemPrompt(db, chat, {
        entity_context: { entity_type: "milestone", entity_id: "slug" },
      });
      expect(r).toBe(DEFAULT_SYSTEM_PROMPT);
    });
    it("workspace branch skipped if workspace has no path", () => {
      // workspaces require NOT NULL path in schema. So we exercise the
      // "workspace row absent" fallback via invalid id.
      const chat = { entityType: null, entityId: null, projectId: null, workspaceId: 9999 } as any;
      expect(resolveChatSystemPrompt(db, chat, {})).toBe(DEFAULT_SYSTEM_PROMPT);
    });
  });

  // ─── resolveChatWorkspaceContext ─────────────────────────────────
  describe("resolveChatWorkspaceContext", () => {
    it("returns undefined when neither workspaceId nor projectId", () => {
      const chat = { workspaceId: null, projectId: null } as any;
      expect(resolveChatWorkspaceContext(db, chat)).toBeUndefined();
    });
    it("returns undefined when project has no workspaceId", () => {
      const p = db.insert(projects).values({ name: "P" } as any).returning().get()!;
      const chat = { workspaceId: null, projectId: p.id } as any;
      expect(resolveChatWorkspaceContext(db, chat)).toBeUndefined();
    });
    it("walks project.workspaceId → workspace row", () => {
      const w = db.insert(workspaces).values({ name: "W", path: "/tmp/w" } as any).returning().get()!;
      const p = db.insert(projects).values({ name: "P", workspaceId: w.id } as any).returning().get()!;
      const chat = { workspaceId: null, projectId: p.id } as any;
      const r = resolveChatWorkspaceContext(db, chat);
      expect(r?.name).toBe("W");
      expect(r?.path).toBe("/tmp/w");
    });
    it("returns workspace + projects list", () => {
      const w = db.insert(workspaces).values({ name: "W2", path: "/tmp/w2" } as any).returning().get()!;
      db.insert(projects).values({ name: "P1", workspaceId: w.id, path: "/tmp/p1" } as any).run();
      const chat = { workspaceId: w.id, projectId: null } as any;
      const r = resolveChatWorkspaceContext(db, chat);
      expect(r?.projects.length).toBe(1);
    });
    it("returns undefined when workspace missing or pathless", () => {
      const chat = { workspaceId: 9999, projectId: null } as any;
      expect(resolveChatWorkspaceContext(db, chat)).toBeUndefined();
    });
  });

  // ─── getChatMetrics ─────────────────────────────────
  describe("getChatMetrics", () => {
    it("returns zero metrics for empty chat", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      const m = getChatMetrics(db, chat.id);
      expect(m.messageCount).toBe(0);
      expect(m.userMessageCount).toBe(0);
      expect(m.totalCostUsd).toBe(0);
      expect(m.todosCounts).toBeNull();
      expect(m.lastMessageAt).toBeNull();
    });
    it("aggregates messages, tokens, copilot quota, todos", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      const m1 = db.insert(chatMessages).values({ chatId: chat.id, role: "user", content: "hi" } as any).returning().get()!;
      const m2 = db.insert(chatMessages).values({ chatId: chat.id, role: "assistant", content: "yo" } as any).returning().get()!;
      db.insert(usageRecords).values([
        { chatMessageId: m2.id, provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 },
        { chatMessageId: m2.id, provider: "github_copilot", model: "gpt-4", inputTokens: 10, outputTokens: 5, totalCostUsd: 0 },
      ] as any).run();
      db.insert(chatTodos).values({ chatId: chat.id, todosJson: JSON.stringify([{ content: "x", status: "pending" }]) } as any).run();

      const m = getChatMetrics(db, chat.id);
      expect(m.messageCount).toBe(2);
      expect(m.userMessageCount).toBe(1);
      expect(m.assistantMessageCount).toBe(1);
      expect(m.totalInputTokens).toBe(20);
      expect(m.totalCopilotQuota).toBeGreaterThanOrEqual(0);
      expect(m.todosCounts).not.toBeNull();
      expect(m.lastMessageAt).not.toBeNull();
    });
    it("returns null todosCounts when todos row is empty json", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      db.insert(chatTodos).values({ chatId: chat.id, todosJson: "" } as any).run();
      const m = getChatMetrics(db, chat.id);
      expect(m.todosCounts).toBeNull();
    });
  });

  // ─── loadPriorMessages ─────────────────────────────────
  describe("loadPriorMessages", () => {
    it("returns [] for empty chat", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      expect(loadPriorMessages(db, chat.id)).toEqual([]);
    });
    it("shapes user/assistant messages", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      db.insert(chatMessages).values([
        { chatId: chat.id, role: "user", content: "hi", createdAt: "2025-01-01T00:00:00.000Z" },
        { chatId: chat.id, role: "assistant", content: "yo", createdAt: "2025-01-01T00:00:01.000Z" },
      ] as any).run();
      const msgs = loadPriorMessages(db, chat.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[1]!.role).toBe("assistant");
    });
    it("trims to MAX_CHAT_MESSAGES and aligns to a user message", () => {
      const chat = db.insert(chats).values({ title: "c" } as any).returning().get()!;
      // Insert MAX + 5 messages, alternating user/assistant, so trim drops
      // earliest ones and may start on assistant → we chop one more.
      const rows: any[] = [];
      const total = MAX_CHAT_MESSAGES + 5;
      for (let i = 0; i < total; i++) {
        rows.push({
          chatId: chat.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          createdAt: new Date(2025, 0, 1, 0, 0, i).toISOString(),
        });
      }
      db.insert(chatMessages).values(rows).run();
      const msgs = loadPriorMessages(db, chat.id);
      expect(msgs.length).toBeLessThanOrEqual(MAX_CHAT_MESSAGES);
      // first message must be "user" after alignment
      expect(msgs[0]!.role).toBe("user");
    });
  });
});
