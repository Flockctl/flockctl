import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  buildBranchName,
  buildWorktreePath,
  cleanupIfClean,
  createWorktree,
  getWorktreeStatus,
  listWorktrees,
  removeWorktree,
  WorktreeError,
} from "../../services/worktree-manager.js";

/**
 * worktree-manager tests use REAL git operations against throwaway
 * directories under `os.tmpdir()`. This is intentional — `git worktree`
 * has subtle interactions with `.git/worktrees/<name>/` admin files,
 * branch refs, and the porcelain output format that mocks would not
 * exercise. Each test starts with a fresh repo (one commit, default
 * branch) so behaviour is deterministic.
 */

let tmpBase: string;
let projectPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Deterministic identity so commit author/committer never depends
      // on the CI host's git config.
      GIT_AUTHOR_NAME: "Flockctl Test",
      GIT_AUTHOR_EMAIL: "test@flockctl.local",
      GIT_COMMITTER_NAME: "Flockctl Test",
      GIT_COMMITTER_EMAIL: "test@flockctl.local",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).toString();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

beforeAll(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "flockctl-wt-"));
});

afterAll(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  // Each test gets its own project path so worktrees / branches don't
  // bleed between cases. `realpathSync` canonicalises through any
  // symlink prefixes (macOS' `/var/folders/...` → `/private/var/...`)
  // so equality checks against `git worktree list --porcelain` output
  // — which always emits the canonical form — line up.
  projectPath = realpathSync(mkdtempSync(join(tmpBase, "proj-")));
});

describe("worktree-manager: helpers", () => {
  it("buildBranchName uses fixed prefix and owner kind/id", () => {
    expect(buildBranchName("task", 42)).toBe("flockctl/task-42");
    expect(buildBranchName("chat", 7)).toBe("flockctl/chat-7");
  });

  it("buildWorktreePath nests under .flockctl/worktrees/", () => {
    expect(buildWorktreePath("/abs/proj", "task", 1)).toBe(
      "/abs/proj/.flockctl/worktrees/task-1",
    );
  });
});

describe("worktree-manager: createWorktree", () => {
  it("creates a fresh worktree and branch from HEAD of the operator's current branch", () => {
    initRepo(projectPath);
    const result = createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });

    expect(result.path).toBe(buildWorktreePath(projectPath, "task", 1));
    expect(result.branch).toBe("flockctl/task-1");
    expect(result.reused).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    // `.git` inside a linked worktree is a *file* with a `gitdir:` pointer.
    const gitMarker = lstatSync(join(result.path, ".git"));
    expect(gitMarker.isFile()).toBe(true);

    // Confirm new worktree's HEAD == project HEAD at creation time.
    const projectHead = git(projectPath, ["rev-parse", "HEAD"]).trim();
    const wtHead = git(result.path, ["rev-parse", "HEAD"]).trim();
    expect(wtHead).toBe(projectHead);

    // Confirm the new branch exists in the project's ref list.
    const branches = git(projectPath, ["branch", "--list", "flockctl/task-1"]);
    expect(branches).toContain("flockctl/task-1");
  });

  it("is idempotent — creating the same owner twice returns reused: true", () => {
    initRepo(projectPath);
    const first = createWorktree({ projectPath, ownerKind: "task", ownerId: 2 });
    const second = createWorktree({ projectPath, ownerKind: "task", ownerId: 2 });
    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(second.reused).toBe(true);
  });

  it("re-uses an existing branch when the worktree directory was removed manually", () => {
    initRepo(projectPath);
    const first = createWorktree({ projectPath, ownerKind: "chat", ownerId: 5 });
    // Operator deleted the dir but git's branch ref survives.
    rmSync(first.path, { recursive: true, force: true });
    git(projectPath, ["worktree", "prune"]);
    // Branch must still be present for this scenario to be meaningful.
    expect(
      git(projectPath, ["branch", "--list", "flockctl/chat-5"]).trim(),
    ).toContain("flockctl/chat-5");

    const second = createWorktree({ projectPath, ownerKind: "chat", ownerId: 5 });
    expect(second.reused).toBe(false);
    expect(second.branch).toBe("flockctl/chat-5");
    expect(existsSync(second.path)).toBe(true);
  });

  it("throws not_a_git_repo when the project path is not a git working tree", () => {
    // No git init — projectPath is just an empty dir.
    expect(() =>
      createWorktree({ projectPath, ownerKind: "task", ownerId: 1 }),
    ).toThrowError(WorktreeError);
    try {
      createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe("not_a_git_repo");
    }
  });

  it("throws no_initial_commit on a repo with no HEAD", () => {
    git(projectPath, ["init", "-q", "-b", "main"]);
    // No initial commit — `git rev-parse HEAD` fails.
    try {
      createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });
      // Unreachable.
      expect.fail("expected createWorktree to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe("no_initial_commit");
    }
  });

  it("throws worktree_path_blocked when the target path exists but is not a worktree", () => {
    initRepo(projectPath);
    const blockedPath = buildWorktreePath(projectPath, "task", 99);
    mkdirSync(blockedPath, { recursive: true });
    writeFileSync(join(blockedPath, "stray.txt"), "I'm in the way\n");

    try {
      createWorktree({ projectPath, ownerKind: "task", ownerId: 99 });
      expect.fail("expected createWorktree to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe("worktree_path_blocked");
    }
  });

  it("rejects non-absolute project paths", () => {
    try {
      createWorktree({ projectPath: "rel/path", ownerKind: "task", ownerId: 1 });
      expect.fail("expected createWorktree to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe("git_command_failed");
    }
  });
});

describe("worktree-manager: getWorktreeStatus", () => {
  it("reports clean worktree when nothing has changed", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });
    const s = getWorktreeStatus(wt.path);
    expect(s.pathExists).toBe(true);
    expect(s.registered).toBe(true);
    expect(s.hasUncommittedChanges).toBe(false);
  });

  it("reports dirty when an untracked file is added", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });
    writeFileSync(join(wt.path, "new.txt"), "hello\n");
    expect(getWorktreeStatus(wt.path).hasUncommittedChanges).toBe(true);
  });

  it("reports dirty when a tracked file is modified", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 1 });
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    expect(getWorktreeStatus(wt.path).hasUncommittedChanges).toBe(true);
  });

  it("reports pathExists=false on missing directory", () => {
    const s = getWorktreeStatus(join(projectPath, "ghost"));
    expect(s.pathExists).toBe(false);
    expect(s.registered).toBe(false);
  });

  it("reports registered=false on a non-worktree directory", () => {
    const stray = join(projectPath, "stray");
    mkdirSync(stray, { recursive: true });
    const s = getWorktreeStatus(stray);
    expect(s.pathExists).toBe(true);
    expect(s.registered).toBe(false);
  });
});

describe("worktree-manager: removeWorktree", () => {
  it("deletes the directory, the registration, and the branch", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 11 });
    removeWorktree({ projectPath, worktreePath: wt.path, branch: wt.branch });

    expect(existsSync(wt.path)).toBe(false);
    // Branch is gone too.
    const list = git(projectPath, ["branch", "--list", wt.branch]);
    expect(list.trim()).toBe("");
    // Worktree registration is gone too.
    const wtList = git(projectPath, ["worktree", "list", "--porcelain"]);
    expect(wtList).not.toContain(wt.path);
  });

  it("is best-effort when the worktree dir was already removed manually", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: 21 });
    rmSync(wt.path, { recursive: true, force: true });
    // Should not throw even though the dir is gone.
    expect(() =>
      removeWorktree({ projectPath, worktreePath: wt.path, branch: wt.branch }),
    ).not.toThrow();
    // Branch should still be cleaned up.
    expect(git(projectPath, ["branch", "--list", wt.branch]).trim()).toBe("");
  });

  it("force=true removes a dirty worktree git would otherwise refuse", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 31 });
    writeFileSync(join(wt.path, "dirty.txt"), "uncommitted\n");
    removeWorktree({
      projectPath,
      worktreePath: wt.path,
      branch: wt.branch,
      force: true,
    });
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("worktree-manager: cleanupIfClean", () => {
  it("removes a clean worktree and reports reason='clean'", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 41 });
    const r = cleanupIfClean({
      projectPath,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(r.removed).toBe(true);
    expect(r.reason).toBe("clean");
    expect(existsSync(wt.path)).toBe(false);
  });

  it("preserves a dirty worktree and reports reason='dirty'", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 42 });
    writeFileSync(join(wt.path, "draft.txt"), "agent's work in progress\n");

    const r = cleanupIfClean({
      projectPath,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(r.removed).toBe(false);
    expect(r.reason).toBe("dirty");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("reports reason='missing' and sweeps the branch when the dir is gone", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: 51 });
    rmSync(wt.path, { recursive: true, force: true });

    const r = cleanupIfClean({
      projectPath,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(r.removed).toBe(true);
    expect(r.reason).toBe("missing");
    expect(git(projectPath, ["branch", "--list", wt.branch]).trim()).toBe("");
  });

  it("reports reason='not_a_git_repo' when project lost its .git dir", () => {
    initRepo(projectPath);
    const wt = createWorktree({ projectPath, ownerKind: "task", ownerId: 61 });
    rmSync(join(projectPath, ".git"), { recursive: true, force: true });
    const r = cleanupIfClean({
      projectPath,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(r.removed).toBe(false);
    expect(r.reason).toBe("not_a_git_repo");
  });
});

describe("worktree-manager: listWorktrees", () => {
  it("returns the main worktree alongside Flockctl-managed entries with managed flags", () => {
    initRepo(projectPath);
    const a = createWorktree({ projectPath, ownerKind: "task", ownerId: 71 });
    const b = createWorktree({ projectPath, ownerKind: "chat", ownerId: 72 });

    const entries = listWorktrees(projectPath);
    // Main worktree + 2 flockctl entries.
    expect(entries.length).toBe(3);

    const main = entries.find((e) => e.path === projectPath);
    expect(main).toBeTruthy();
    expect(main!.managed).toBe(false);

    const taskEntry = entries.find((e) => e.path === a.path);
    expect(taskEntry?.branch).toBe(a.branch);
    expect(taskEntry?.managed).toBe(true);

    const chatEntry = entries.find((e) => e.path === b.path);
    expect(chatEntry?.branch).toBe(b.branch);
    expect(chatEntry?.managed).toBe(true);
  });

  it("flags an operator-created worktree as managed=false", () => {
    initRepo(projectPath);
    // Operator creates their own worktree outside Flockctl's prefix.
    // Resolve through realpath so the canonical form matches what
    // `git worktree list --porcelain` reports (symlink-stripped).
    const operatorWtPath = realpathSync(join(projectPath, "..")) + "/operator-wt";
    git(projectPath, ["worktree", "add", "-b", "feature/x", operatorWtPath, "HEAD"]);

    try {
      const entries = listWorktrees(projectPath);
      const op = entries.find((e) => e.path === operatorWtPath);
      expect(op).toBeTruthy();
      expect(op!.managed).toBe(false);
      expect(op!.branch).toBe("feature/x");
    } finally {
      // Cleanup so the next test doesn't trip over a stale registration.
      git(projectPath, ["worktree", "remove", "--force", operatorWtPath]);
    }
  });

  it("returns [] for a non-git directory", () => {
    expect(listWorktrees(projectPath)).toEqual([]);
  });
});
