import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import {
  projects as projectsTable,
  chats as chatsTable,
} from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createWorktree } from "../../services/worktree-manager.js";

/**
 * End-to-end coverage of the per-chat worktree isolation surface:
 *
 *   POST /chats                — accepts `isolation: "worktree"`.
 *   POST /chats/:id/end-session — clean / dirty / force / not-found.
 *   DELETE /chats/:id          — 409 on dirty without `?force=true`.
 *
 * Worktree creation in `resolveChatCwd` is exercised indirectly: we
 * pre-create the worktree via the manager (the same code the lazy
 * path uses) and assert the cleanup endpoints honour it. The lazy
 * creation path itself runs inside POST /chats/:id/messages, which
 * needs the AgentSession harness from the main chats.test.ts; for
 * THIS file we keep the surface narrow and skip that.
 */

// Stub chatExecutor so the route layer doesn't try to spawn a real
// session when DELETE / end-session run their `cancel()` branches.
vi.mock("../../services/chat-executor.js", () => ({
  chatExecutor: {
    isRunning: () => false,
    cancel: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    claim: vi.fn(),
    activeSessions: () => [].values(),
    pendingPermissions: () => [],
    pendingQuestions: () => [],
    isolateMessageStream: vi.fn(),
  },
}));

describe("Chats API — worktree isolation", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let tmpBase: string;
  let projectPath: string;
  let projectId: number;

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Flockctl Test",
        GIT_AUTHOR_EMAIL: "test@flockctl.local",
        GIT_COMMITTER_NAME: "Flockctl Test",
        GIT_COMMITTER_EMAIL: "test@flockctl.local",
      },
    }).toString();
  }

  function initProjectRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    tmpBase = mkdtempSync(join(tmpdir(), "flockctl-chats-iso-"));
  });

  afterAll(() => {
    testDb.sqlite.close();
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    testDb.sqlite.exec("DELETE FROM chat_messages; DELETE FROM chats; DELETE FROM projects;");
    projectPath = realpathSync(mkdtempSync(join(tmpBase, "proj-")));
    initProjectRepo(projectPath);
    const inserted = testDb.db
      .insert(projectsTable)
      .values({ name: `proj-${Date.now()}-${Math.random()}`, path: projectPath })
      .returning()
      .get();
    projectId = inserted!.id;
  });

  describe("POST /chats with isolation", () => {
    it("accepts isolation='worktree' and persists it", async () => {
      const res = await app.request("/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, isolation: "worktree" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number; isolation: string };
      expect(body.isolation).toBe("worktree");

      const row = testDb.db.select().from(chatsTable).where(eq(chatsTable.id, body.id)).get();
      expect(row?.isolation).toBe("worktree");
      // Worktree NOT created at chat creation — that's lazy on the
      // first message.
      expect(row?.worktreePath).toBeNull();
      expect(row?.worktreeBranch).toBeNull();
    });

    it("rejects an unknown isolation mode with 422", async () => {
      const res = await app.request("/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, isolation: "sandbox" }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("POST /chats/:id/end-session", () => {
    function chatWithWorktree(): { chatId: number; wtPath: string; branch: string } {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({
        projectPath,
        ownerKind: "chat",
        ownerId: chat!.id,
      });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();
      return { chatId: chat!.id, wtPath: wt.path, branch: wt.branch };
    }

    it("cleans a clean worktree and reports reason='clean'", async () => {
      const { chatId } = chatWithWorktree();
      const res = await app.request(`/chats/${chatId}/end-session`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: boolean; reason: string };
      expect(body.removed).toBe(true);
      expect(body.reason).toBe("clean");

      const row = testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chatId)).get();
      expect(row?.worktreePath).toBeNull();
      expect(row?.worktreeBranch).toBeNull();
    });

    it("returns 409 with dirty reason on uncommitted changes", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      writeFileSync(join(wtPath, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chatId}/end-session`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe("dirty");

      const row = testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chatId)).get();
      expect(row?.worktreePath).toBe(wtPath);
    });

    it("force=true discards a dirty worktree", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      writeFileSync(join(wtPath, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chatId}/end-session?force=true`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: boolean; reason: string };
      expect(body.removed).toBe(true);
      expect(body.reason).toBe("forced");

      const row = testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chatId)).get();
      expect(row?.worktreePath).toBeNull();
    });

    it("404 when the chat has no worktree recorded", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId })
        .returning()
        .get();
      const res = await app.request(`/chats/${chat!.id}/end-session`, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("422 when the chat has a worktree row but no project link", async () => {
      // Construct a malformed row (worktree set, project null) — the
      // executor would never produce this, but the safety branch is
      // still worth testing so the route is forced to return a sane
      // 422 rather than 5xx if it's ever reached.
      const chat = testDb.db
        .insert(chatsTable)
        .values({
          isolation: "worktree",
          worktreePath: join(projectPath, ".flockctl/worktrees/chat-orphan"),
          worktreeBranch: "flockctl/chat-orphan",
        })
        .returning()
        .get();
      const res = await app.request(`/chats/${chat!.id}/end-session`, { method: "POST" });
      expect(res.status).toBe(422);
    });
  });

  describe("DELETE /chats/:id/worktree (alias of POST /end-session)", () => {
    it("clean → 200 with reason 'clean'", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();

      const res = await app.request(`/chats/${chat!.id}/worktree`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: boolean; reason: string };
      expect(body.removed).toBe(true);
      expect(body.reason).toBe("clean");
    });

    it("dirty → 409", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();
      writeFileSync(join(wt.path, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chat!.id}/worktree`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /chats/:id with worktree", () => {
    it("blocks deletion of a chat with a dirty worktree (409 without force)", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();
      writeFileSync(join(wt.path, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chat!.id}`, { method: "DELETE" });
      expect(res.status).toBe(409);

      // Chat row still alive.
      expect(
        testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chat!.id)).get(),
      ).toBeTruthy();
    });

    it("deletes a chat with a clean worktree, sweeping the worktree on the way out", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();

      const res = await app.request(`/chats/${chat!.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);

      expect(
        testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chat!.id)).get(),
      ).toBeUndefined();
    });

    it("force=true tears down even a dirty worktree", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();
      writeFileSync(join(wt.path, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chat!.id}?force=true`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(
        testDb.db.select().from(chatsTable).where(eq(chatsTable.id, chat!.id)).get(),
      ).toBeUndefined();
    });
  });

  // ─── POST /chats/:id/worktree/apply ───
  //
  // Counterpart to End session: instead of throwing the chat's commits
  // away, lands them on the project's currently-checked-out branch via
  // `git merge --no-ff`. The worktree itself is preserved (operator
  // can keep iterating in the chat). These tests exercise the real
  // backend `applyWorktreeBranch` against a tmp git repo, including
  // every actionable failure mode.
  describe("POST /chats/:id/worktree/apply", () => {
    function chatWithWorktree(): {
      chatId: number;
      wtPath: string;
      branch: string;
    } {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({
        projectPath,
        ownerKind: "chat",
        ownerId: chat!.id,
      });
      testDb.db
        .update(chatsTable)
        .set({ worktreePath: wt.path, worktreeBranch: wt.branch })
        .where(eq(chatsTable.id, chat!.id))
        .run();
      return { chatId: chat!.id, wtPath: wt.path, branch: wt.branch };
    }

    function commitInWorktree(wtPath: string, file: string, body: string): string {
      writeFileSync(join(wtPath, file), body);
      git(wtPath, ["add", file]);
      git(wtPath, ["commit", "-q", "-m", `add ${file}`]);
      return git(wtPath, ["rev-parse", "HEAD"]).trim();
    }

    it("merges the worktree branch into the project's current branch", async () => {
      const { chatId, wtPath, branch } = chatWithWorktree();
      const tip = commitInWorktree(wtPath, "feature.md", "# feature\n");

      const res = await app.request(`/chats/${chatId}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        applied: boolean;
        reason: string;
        sourceBranch: string;
        targetBranch: string;
        mergeCommit: string;
      };
      expect(body.applied).toBe(true);
      expect(body.reason).toBe("merged");
      expect(body.sourceBranch).toBe(branch);
      expect(body.targetBranch).toBe("main");
      expect(body.mergeCommit).toMatch(/^[0-9a-f]{40}$/);

      // Project HEAD now contains the worktree's commit as a parent.
      const log = git(projectPath, ["log", "--all", "--oneline"]);
      expect(log).toContain(tip.slice(0, 7));
      // Worktree itself survives — Apply does not destroy it.
      const row = testDb.db
        .select()
        .from(chatsTable)
        .where(eq(chatsTable.id, chatId))
        .get();
      expect(row?.worktreePath).toBe(wtPath);
      expect(row?.worktreeBranch).toBe(branch);
    });

    it("returns reason 'already_merged' when the source is an ancestor of HEAD", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      const tip = commitInWorktree(wtPath, "feature.md", "# feature\n");
      // Pre-merge so the second Apply finds the source already reachable.
      git(projectPath, ["merge", "--no-ff", "--no-edit", "-m", "pre-merge", "flockctl/chat-" + chatId]);

      const res = await app.request(`/chats/${chatId}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        applied: boolean;
        reason: string;
        mergeCommit: string;
      };
      expect(body.applied).toBe(true);
      expect(body.reason).toBe("already_merged");
      // mergeCommit echoes current HEAD; worktree tip is reachable from it.
      expect(body.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
      const reachable = git(projectPath, ["log", "--oneline"]);
      expect(reachable).toContain(tip.slice(0, 7));
    });

    it("409 worktree_dirty when the worktree has uncommitted changes", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      writeFileSync(join(wtPath, "draft.txt"), "wip\n");

      const res = await app.request(`/chats/${chatId}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe("worktree_dirty");
    });

    it("409 project_dirty when the project's main directory has uncommitted changes", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      commitInWorktree(wtPath, "feature.md", "# feature\n");
      // Dirty the main project directory.
      writeFileSync(join(projectPath, "README.md"), "# fixture\n\n(WIP)\n");

      const res = await app.request(`/chats/${chatId}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe("project_dirty");
    });

    it("409 conflict when the merge produces conflicting paths and aborts cleanly", async () => {
      const { chatId, wtPath } = chatWithWorktree();
      // Both branches modify the same file with incompatible content.
      commitInWorktree(wtPath, "README.md", "# from worktree\n");
      writeFileSync(join(projectPath, "README.md"), "# from main\n");
      git(projectPath, ["add", "README.md"]);
      git(projectPath, ["commit", "-q", "-m", "main side"]);

      const res = await app.request(`/chats/${chatId}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        details: { reason: string; conflicts?: string[] };
      };
      expect(body.details.reason).toBe("conflict");
      expect(body.details.conflicts).toContain("README.md");

      // Critical: project's main directory must be CLEAN after the
      // abort — `git merge --abort` should have unwound the merge
      // attempt, leaving the operator's HEAD untouched. We filter out
      // `.flockctl/` (our managed worktree namespace) the same way
      // applyWorktreeBranch's project_dirty check does — it's
      // expected to appear as untracked in test fixtures because
      // skills-sync hasn't wired `.git/info/exclude` here.
      const status = git(projectPath, ["status", "--porcelain"])
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .filter((l) => !l.endsWith(".flockctl/") && !l.includes(".flockctl/"));
      expect(status).toEqual([]);
    });

    it("404 when the chat has no worktree recorded", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId })
        .returning()
        .get();
      const res = await app.request(`/chats/${chat!.id}/worktree/apply`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});
