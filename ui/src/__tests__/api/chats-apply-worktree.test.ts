import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyChatWorktree,
  ApiError,
  type ApplyChatWorktreeResponse,
} from "@/lib/api";

/**
 * Coverage for the "Apply changes from worktree" client-side surface:
 *
 *   - `applyChatWorktree(chatId)` POSTs to /chats/:id/worktree/apply
 *     and returns the snake-cased response body.
 *   - 409 with `details.reason` propagates through `ApiError` so the
 *     caller can branch on `worktree_dirty` / `project_dirty` /
 *     `project_detached` / `conflict` and surface the right copy.
 *
 * The page-level handler `handleApplyWorktree` (chats.tsx) narrows on
 * `details.reason` via the local `applyWorktreeErrorDetails` helper —
 * those branches are validated indirectly here by asserting the error
 * shape `applyChatWorktree` actually surfaces.
 */

let lsStore: Record<string, string> = {};
const mockLs = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = v;
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    lsStore = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  lsStore = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLs,
    configurable: true,
    writable: true,
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("applyChatWorktree", () => {
  it("POSTs to /chats/:id/worktree/apply and returns the snake-cased body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        applied: true,
        reason: "merged",
        sourceBranch: "flockctl/chat-7",
        targetBranch: "main",
        mergeCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const r: ApplyChatWorktreeResponse = await applyChatWorktree("chat-7");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/chats\/chat-7\/worktree\/apply$/);
    expect(init.method).toBe("POST");

    expect(r.applied).toBe(true);
    expect(r.reason).toBe("merged");
    // camelCase → snake_case in the response body, per `apiFetch`'s
    // key conversion. The page handler reads `r.merge_commit`,
    // `r.source_branch`, `r.target_branch` directly.
    expect(r.source_branch).toBe("flockctl/chat-7");
    expect(r.target_branch).toBe("main");
    expect(r.merge_commit).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });

  it("preserves `already_merged` reason on idempotent re-apply", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        applied: true,
        reason: "already_merged",
        sourceBranch: "flockctl/chat-3",
        targetBranch: "main",
        mergeCommit: "f00ba5".padEnd(40, "0"),
      }),
    );
    const r = await applyChatWorktree("chat-3");
    expect(r.applied).toBe(true);
    expect(r.reason).toBe("already_merged");
  });

  it("throws ApiError 409 with details.reason for worktree_dirty", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "The chat's worktree has uncommitted changes",
          details: {
            reason: "worktree_dirty",
            sourceBranch: "flockctl/chat-9",
            targetBranch: "",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    let caught: unknown;
    try {
      await applyChatWorktree("chat-9");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(409);
    // The page handler reads details.reason to pick the right alert
    // copy — must survive the throw.
    expect(err.details).toMatchObject({ reason: "worktree_dirty" });
  });

  it("threads conflict file list through details for the conflict branch", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Merge conflict",
          details: {
            reason: "conflict",
            sourceBranch: "flockctl/chat-2",
            targetBranch: "main",
            conflicts: ["README.md", "src/index.ts"],
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    let caught: unknown;
    try {
      await applyChatWorktree("chat-2");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const details = (caught as ApiError).details as {
      reason: string;
      conflicts: string[];
    };
    expect(details.reason).toBe("conflict");
    expect(details.conflicts).toEqual(["README.md", "src/index.ts"]);
  });

  it("propagates project_detached as an actionable 409 reason", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "The project is on a detached HEAD",
          details: { reason: "project_detached" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    let caught: unknown;
    try {
      await applyChatWorktree("chat-4");
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).details).toMatchObject({
      reason: "project_detached",
    });
  });
});
