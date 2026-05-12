import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import {
  aiProviderKeys,
  projects,
  workspaces,
} from "../../db/schema.js";
import {
  resolveAllowedKeyIds,
} from "../../services/ai/key-selection.js";
import {
  resolveDefaultKeyForChat,
  resolveChatKeyId,
  assertKeyAllowedForChat,
} from "../../routes/chats/helpers.js";
import { setGlobalDefaults } from "../../config/defaults.js";
import { ValidationError } from "../../lib/errors.js";

/**
 * Workspace-only chats (started from the workspace page, no project context)
 * used to bypass every allow-list / default-key check because the helpers
 * keyed on `projectId` and short-circuited when it was null. This file pins
 * the post-fix contract: the workspace's own `allowed_key_ids` whitelist is
 * honored and the rc-level default is auto-promoted into the chat row at
 * creation time, the same way it already works for project-scoped chats.
 */
describe("workspace-only chat key resolution", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    testDb = createTestDb();
    db = testDb.db;
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    setGlobalDefaults({ defaultKeyId: null });
    closeDb();
  });

  // ─── resolveAllowedKeyIds ────────────────────────────────────────────
  describe("resolveAllowedKeyIds — workspace-only branch", () => {
    it("returns the workspace allow-list when given workspaceId only", () => {
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([3, 5, 8]),
        } as any)
        .returning()
        .get()!;
      expect(
        resolveAllowedKeyIds({ projectId: null, workspaceId: ws.id }),
      ).toEqual([3, 5, 8]);
    });

    it("returns [] for workspace with no allow-list", () => {
      const ws = db
        .insert(workspaces)
        .values({ name: "WS", path: "/tmp/ws" } as any)
        .returning()
        .get()!;
      expect(
        resolveAllowedKeyIds({ projectId: null, workspaceId: ws.id }),
      ).toEqual([]);
    });

    it("returns [] for missing workspaceId (no project, no workspace)", () => {
      expect(
        resolveAllowedKeyIds({ projectId: null, workspaceId: null }),
      ).toEqual([]);
    });

    it("project allow-list wins when both are given (no merge)", () => {
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([1, 2]),
        } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({
          name: "P",
          workspaceId: ws.id,
          allowedKeyIds: JSON.stringify([7]),
        } as any)
        .returning()
        .get()!;
      // Project override beats both the workspace list AND any workspaceId
      // hint — matches the documented "project overrides workspace, no
      // merge" inheritance rule.
      expect(
        resolveAllowedKeyIds({ projectId: p.id, workspaceId: ws.id }),
      ).toEqual([7]);
    });

    it("project with no list still inherits its workspace, ignoring the explicit workspaceId hint", () => {
      // Two workspaces in play: the one the project is bound to (wsBound)
      // and an unrelated one passed in via the `workspaceId` field. The
      // project's own binding wins — matches `resolveAllowedKeyIds`'s
      // documented precedence.
      const wsBound = db
        .insert(workspaces)
        .values({
          name: "WSb",
          path: "/tmp/wsb",
          allowedKeyIds: JSON.stringify([10, 11]),
        } as any)
        .returning()
        .get()!;
      const wsUnrelated = db
        .insert(workspaces)
        .values({
          name: "WSu",
          path: "/tmp/wsu",
          allowedKeyIds: JSON.stringify([99]),
        } as any)
        .returning()
        .get()!;
      const p = db
        .insert(projects)
        .values({ name: "P", workspaceId: wsBound.id } as any)
        .returning()
        .get()!;
      expect(
        resolveAllowedKeyIds({ projectId: p.id, workspaceId: wsUnrelated.id }),
      ).toEqual([10, 11]);
    });

    it("orphan project + workspaceId fallback returns workspace list", () => {
      // Project lookup misses (id 9999 doesn't exist); the function must
      // still try the workspace branch instead of bailing with [].
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([42]),
        } as any)
        .returning()
        .get()!;
      expect(
        resolveAllowedKeyIds({ projectId: 9999, workspaceId: ws.id }),
      ).toEqual([42]);
    });

    it("orphan project + no workspaceId returns []", () => {
      // Preserves legacy "missing project → no restriction" behavior when
      // no workspace context is supplied.
      expect(
        resolveAllowedKeyIds({ projectId: 9999, workspaceId: null }),
      ).toEqual([]);
    });
  });

  // ─── resolveDefaultKeyForChat ────────────────────────────────────────
  describe("resolveDefaultKeyForChat — workspace-only chat", () => {
    it("picks the first active allowed key for a workspace whitelist", () => {
      const k1 = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "k1",
          isActive: true,
          priority: 1,
        } as any)
        .returning()
        .get()!;
      const k2 = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "k2",
          isActive: true,
          priority: 2,
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([k2.id]),
        } as any)
        .returning()
        .get()!;
      // Only k2 is on the workspace whitelist, so even though k1 has
      // higher priority globally the helper must pick k2.
      expect(
        resolveDefaultKeyForChat(db, {
          projectId: null,
          workspaceId: ws.id,
        }),
      ).toBe(k2.id);
      // Make sure we didn't accidentally introduce a dependency on k1.
      expect(k1.id).not.toBe(k2.id);
    });

    it("returns rc default when it's active and in the workspace allowlist", () => {
      const k1 = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "k1",
          isActive: true,
          priority: 1,
        } as any)
        .returning()
        .get()!;
      const k2 = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "k2",
          isActive: true,
          priority: 2,
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([k1.id, k2.id]),
        } as any)
        .returning()
        .get()!;
      // rc default points at k2 — it's allowed AND active, so it wins
      // over priority order (matches the project-scoped contract).
      setGlobalDefaults({ defaultKeyId: k2.id });
      expect(
        resolveDefaultKeyForChat(db, {
          projectId: null,
          workspaceId: ws.id,
        }),
      ).toBe(k2.id);
    });

    it("returns undefined when workspace whitelist has no active keys", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "inactive",
          isActive: false,
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([k.id]),
        } as any)
        .returning()
        .get()!;
      expect(
        resolveDefaultKeyForChat(db, {
          projectId: null,
          workspaceId: ws.id,
        }),
      ).toBeUndefined();
    });
  });

  // ─── resolveChatKeyId ────────────────────────────────────────────────
  describe("resolveChatKeyId — workspace-only chat", () => {
    it("uses the chat row's stored key when active and allowed", () => {
      const k = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "k",
          isActive: true,
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([k.id]),
        } as any)
        .returning()
        .get()!;
      expect(
        resolveChatKeyId(db, undefined, {
          aiProviderKeyId: k.id,
          projectId: null,
          workspaceId: ws.id,
        }),
      ).toBe(k.id);
    });

    it("falls through to the workspace-aware default when stored key is stale", () => {
      const stale = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "stale",
          isActive: false,
        } as any)
        .returning()
        .get()!;
      const fresh = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "fresh",
          isActive: true,
          priority: 1,
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([fresh.id]),
        } as any)
        .returning()
        .get()!;
      expect(
        resolveChatKeyId(db, undefined, {
          aiProviderKeyId: stale.id,
          projectId: null,
          workspaceId: ws.id,
        }),
      ).toBe(fresh.id);
    });
  });

  // ─── assertKeyAllowedForChat ─────────────────────────────────────────
  describe("assertKeyAllowedForChat — workspace-only chat", () => {
    it("rejects a key not in the workspace whitelist", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "ok",
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([ok.id]),
        } as any)
        .returning()
        .get()!;
      try {
        assertKeyAllowedForChat(
          db,
          { projectId: null, workspaceId: ws.id },
          9999,
          "request",
        );
        expect.fail("expected throw");
      } catch (e: unknown) {
        // The error must scope to "workspace" (not "project") and point
        // the user at the workspace PATCH endpoint, otherwise the hint
        // sends them to the wrong screen.
        const err = e as Error;
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.message).toMatch(/this chat's workspace/);
        expect(err.message).toMatch(/#9999/);
        expect(err.message).toMatch(/PATCH \/workspaces/);
      }
    });

    it("passes when the key is in the workspace whitelist", () => {
      const ok = db
        .insert(aiProviderKeys)
        .values({
          provider: "anthropic",
          providerType: "api",
          label: "ok",
        } as any)
        .returning()
        .get()!;
      const ws = db
        .insert(workspaces)
        .values({
          name: "WS",
          path: "/tmp/ws",
          allowedKeyIds: JSON.stringify([ok.id]),
        } as any)
        .returning()
        .get()!;
      expect(() =>
        assertKeyAllowedForChat(
          db,
          { projectId: null, workspaceId: ws.id },
          ok.id,
          "request",
        ),
      ).not.toThrow();
    });
  });
});
