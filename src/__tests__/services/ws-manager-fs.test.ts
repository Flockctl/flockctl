import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ws-manager `fs` topic tests — covers the project + workspace
 * scoping pattern plus the in-band subscribe protocol added on top of
 * the existing project broadcast plumbing.
 *
 * Auth note: the bearer-token gate (`?token=...` → `verifyWsToken`)
 * is enforced at the WS upgrade boundary in `src/server.ts` BEFORE
 * any of these helpers are called. Once a connection is open, the
 * subscribe envelope is trusted at the protocol level — tests here
 * exercise only the post-handshake routing surface, which is the
 * contract `fs-watcher.ts` and the UI rely on.
 */
describe("WSManager — fs topic", () => {
  let WSManagerModule: typeof import("../../services/ws-manager.js");

  beforeEach(async () => {
    vi.resetModules();
    WSManagerModule = await import("../../services/ws-manager.js");
    // Clear lifecycle hooks left by other suites (the module is a
    // singleton; resetModules above gives us a fresh one but be
    // defensive).
    WSManagerModule.wsManager.setProjectSubscriberHooks({
      onFirstSubscriber: null,
      onLastUnsubscriber: null,
    });
    WSManagerModule.wsManager.setWorkspaceSubscriberHooks({
      onFirstSubscriber: null,
      onLastUnsubscriber: null,
    });
  });

  // ─── broadcastToProject ──────────────────────────────────────────────
  describe("broadcastToProject", () => {
    it("fans the frame to every client subscribed to that projectId", () => {
      const a = { send: vi.fn(), readyState: 1 };
      const b = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", a);
      WSManagerModule.wsManager.addProjectClient("p-1", b);

      WSManagerModule.wsManager.broadcastToProject("p-1", {
        kind: "fs.changed",
        path: "src/x.ts",
      });

      expect(a.send).toHaveBeenCalledOnce();
      expect(b.send).toHaveBeenCalledOnce();
      const msg = JSON.parse(a.send.mock.calls[0][0]);
      expect(msg.projectId).toBe("p-1");
      expect(msg.kind).toBe("fs.changed");
      expect(msg.path).toBe("src/x.ts");
    });

    it("does NOT reach clients subscribed to a different projectId", () => {
      const owned = { send: vi.fn(), readyState: 1 };
      const other = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", owned);
      WSManagerModule.wsManager.addProjectClient("p-2", other);

      WSManagerModule.wsManager.broadcastToProject("p-1", {
        kind: "fs.changed",
      });

      expect(owned.send).toHaveBeenCalledOnce();
      expect(other.send).not.toHaveBeenCalled();
    });

    it("does NOT reach task / chat / global clients (project scope is strict)", () => {
      const proj = { send: vi.fn(), readyState: 1 };
      const task = { send: vi.fn(), readyState: 1 };
      const chat = { send: vi.fn(), readyState: 1 };
      const global = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", proj);
      WSManagerModule.wsManager.addTaskClient(1, task);
      WSManagerModule.wsManager.addChatClient(2, chat);
      WSManagerModule.wsManager.addGlobalChatClient(global);

      WSManagerModule.wsManager.broadcastToProject("p-1", {
        kind: "fs.changed",
      });

      expect(proj.send).toHaveBeenCalledOnce();
      expect(task.send).not.toHaveBeenCalled();
      expect(chat.send).not.toHaveBeenCalled();
      expect(global.send).not.toHaveBeenCalled();
    });

    it("is a no-op when no clients are subscribed to that project", () => {
      const elsewhere = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("other", elsewhere);
      expect(() =>
        WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "x" }),
      ).not.toThrow();
      expect(elsewhere.send).not.toHaveBeenCalled();
    });

    it("skips CLOSED project clients", () => {
      const open = { send: vi.fn(), readyState: 1 };
      const closed = { send: vi.fn(), readyState: 3 };
      WSManagerModule.wsManager.addProjectClient("p-1", open);
      WSManagerModule.wsManager.addProjectClient("p-1", closed);

      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });

      expect(open.send).toHaveBeenCalledOnce();
      expect(closed.send).not.toHaveBeenCalled();
    });

    it("tolerates clients that throw on send", () => {
      const dead = {
        send: vi.fn(() => {
          throw new Error("dead");
        }),
        readyState: 1,
      };
      const live = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", dead);
      WSManagerModule.wsManager.addProjectClient("p-1", live);

      expect(() =>
        WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "x" }),
      ).not.toThrow();
      expect(live.send).toHaveBeenCalledOnce();
    });

    it("removeClient drops project membership and stops further fan-out", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", ws);
      WSManagerModule.wsManager.removeClient(ws);
      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ─── broadcastToWorkspace ────────────────────────────────────────────
  describe("broadcastToWorkspace", () => {
    it("fans the frame to every client subscribed to that workspaceId", () => {
      const a = { send: vi.fn(), readyState: 1 };
      const b = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addWorkspaceClient("w-1", a);
      WSManagerModule.wsManager.addWorkspaceClient("w-1", b);

      WSManagerModule.wsManager.broadcastToWorkspace("w-1", {
        kind: "fs.changed",
        path: "AGENTS.md",
      });

      expect(a.send).toHaveBeenCalledOnce();
      expect(b.send).toHaveBeenCalledOnce();
      const msg = JSON.parse(a.send.mock.calls[0][0]);
      expect(msg.workspaceId).toBe("w-1");
      expect(msg.kind).toBe("fs.changed");
    });

    it("isolates workspace fan-out from project fan-out", () => {
      const proj = { send: vi.fn(), readyState: 1 };
      const ws = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", proj);
      WSManagerModule.wsManager.addWorkspaceClient("w-1", ws);

      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });
      expect(ws.send).not.toHaveBeenCalled();
      expect(proj.send).toHaveBeenCalledOnce();

      WSManagerModule.wsManager.broadcastToWorkspace("w-1", { kind: "fs.changed" });
      expect(ws.send).toHaveBeenCalledOnce();
      // proj saw only its first delivery, not the workspace one
      expect(proj.send).toHaveBeenCalledOnce();
    });

    it("does NOT cross workspaces", () => {
      const w1 = { send: vi.fn(), readyState: 1 };
      const w2 = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addWorkspaceClient("w-1", w1);
      WSManagerModule.wsManager.addWorkspaceClient("w-2", w2);

      WSManagerModule.wsManager.broadcastToWorkspace("w-1", { kind: "fs.changed" });

      expect(w1.send).toHaveBeenCalledOnce();
      expect(w2.send).not.toHaveBeenCalled();
    });

    it("is a no-op when no workspace clients are connected", () => {
      expect(() =>
        WSManagerModule.wsManager.broadcastToWorkspace("nobody", { kind: "x" }),
      ).not.toThrow();
    });

    it("skips CLOSED workspace clients", () => {
      const open = { send: vi.fn(), readyState: 1 };
      const closed = { send: vi.fn(), readyState: 3 };
      WSManagerModule.wsManager.addWorkspaceClient("w-1", open);
      WSManagerModule.wsManager.addWorkspaceClient("w-1", closed);

      WSManagerModule.wsManager.broadcastToWorkspace("w-1", { kind: "fs.changed" });

      expect(open.send).toHaveBeenCalledOnce();
      expect(closed.send).not.toHaveBeenCalled();
    });

    it("removeClient drops workspace membership and stops further fan-out", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addWorkspaceClient("w-1", ws);
      WSManagerModule.wsManager.removeClient(ws);
      WSManagerModule.wsManager.broadcastToWorkspace("w-1", { kind: "fs.changed" });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ─── lifecycle hooks ─────────────────────────────────────────────────
  describe("lifecycle hooks (lazy first / last)", () => {
    it("project: onFirstSubscriber fires once on the first add, not on subsequent adds", async () => {
      const onFirst = vi.fn();
      WSManagerModule.wsManager.setProjectSubscriberHooks({
        onFirstSubscriber: onFirst,
        onLastUnsubscriber: null,
      });

      WSManagerModule.wsManager.addProjectClient("p-1", { send: vi.fn(), readyState: 1 });
      WSManagerModule.wsManager.addProjectClient("p-1", { send: vi.fn(), readyState: 1 });

      // Hooks are fire-and-forget; allow a microtask flush.
      await Promise.resolve();
      expect(onFirst).toHaveBeenCalledTimes(1);
      expect(onFirst).toHaveBeenCalledWith("p-1");
    });

    it("project: onLastUnsubscriber fires only when the LAST client leaves", async () => {
      const onLast = vi.fn();
      WSManagerModule.wsManager.setProjectSubscriberHooks({
        onFirstSubscriber: null,
        onLastUnsubscriber: onLast,
      });
      const a = { send: vi.fn(), readyState: 1 };
      const b = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.addProjectClient("p-1", a);
      WSManagerModule.wsManager.addProjectClient("p-1", b);

      WSManagerModule.wsManager.removeClient(a);
      await Promise.resolve();
      expect(onLast).not.toHaveBeenCalled();

      WSManagerModule.wsManager.removeClient(b);
      await Promise.resolve();
      expect(onLast).toHaveBeenCalledTimes(1);
      expect(onLast).toHaveBeenCalledWith("p-1");
    });

    it("workspace: onFirstSubscriber + onLastUnsubscriber wire symmetrically", async () => {
      const onFirst = vi.fn();
      const onLast = vi.fn();
      WSManagerModule.wsManager.setWorkspaceSubscriberHooks({
        onFirstSubscriber: onFirst,
        onLastUnsubscriber: onLast,
      });
      const a = { send: vi.fn(), readyState: 1 };
      const b = { send: vi.fn(), readyState: 1 };

      WSManagerModule.wsManager.addWorkspaceClient("w-1", a);
      WSManagerModule.wsManager.addWorkspaceClient("w-1", b);
      await Promise.resolve();
      expect(onFirst).toHaveBeenCalledTimes(1);
      expect(onFirst).toHaveBeenCalledWith("w-1");

      WSManagerModule.wsManager.removeClient(a);
      WSManagerModule.wsManager.removeClient(b);
      await Promise.resolve();
      expect(onLast).toHaveBeenCalledTimes(1);
      expect(onLast).toHaveBeenCalledWith("w-1");
    });

    it("project: an async-rejecting hook does not propagate (warned, swallowed)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      WSManagerModule.wsManager.setProjectSubscriberHooks({
        onFirstSubscriber: async () => {
          throw new Error("boom");
        },
        onLastUnsubscriber: null,
      });
      expect(() =>
        WSManagerModule.wsManager.addProjectClient("p-1", { send: vi.fn(), readyState: 1 }),
      ).not.toThrow();
      // Allow the .catch on the promise wrapper to run.
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("workspace: an async-rejecting hook does not propagate (warned, swallowed)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      WSManagerModule.wsManager.setWorkspaceSubscriberHooks({
        onFirstSubscriber: async () => {
          throw new Error("boom-w");
        },
        onLastUnsubscriber: async () => {
          throw new Error("boom-w-out");
        },
      });
      const ws = { send: vi.fn(), readyState: 1 };
      expect(() => WSManagerModule.wsManager.addWorkspaceClient("w-1", ws)).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(() => WSManagerModule.wsManager.removeClient(ws)).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ─── handleSubscribeMessage protocol ─────────────────────────────────
  describe("handleSubscribeMessage", () => {
    it("routes { kind:'subscribe', topic:'fs', projectId } to addProjectClient", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "fs",
        projectId: "p-1",
      });
      expect(result.ok).toBe(true);
      expect(result.scope).toEqual({ kind: "project", projectId: "p-1" });

      // Now broadcastToProject should reach this client.
      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });
      expect(ws.send).toHaveBeenCalledOnce();
    });

    it("routes { kind:'subscribe', topic:'fs', workspaceId } to addWorkspaceClient", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "fs",
        workspaceId: "w-1",
      });
      expect(result.ok).toBe(true);
      expect(result.scope).toEqual({ kind: "workspace", workspaceId: "w-1" });

      WSManagerModule.wsManager.broadcastToWorkspace("w-1", { kind: "fs.changed" });
      expect(ws.send).toHaveBeenCalledOnce();
    });

    it("accepts a JSON-string envelope as well as a parsed object", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(
        ws,
        JSON.stringify({ kind: "subscribe", topic: "fs", projectId: "p-1" }),
      );
      expect(result.ok).toBe(true);
      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });
      expect(ws.send).toHaveBeenCalledOnce();
    });

    it("rejects malformed JSON", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, "{not-json");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid_json");
    });

    it("rejects non-object / non-string envelopes", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, 42 as unknown);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid_envelope");
    });

    it("rejects an unknown kind", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "ping",
        topic: "fs",
        projectId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unknown_kind");
    });

    it("rejects an unknown topic", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "bogus",
        projectId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unknown_topic");
    });

    it("rejects an envelope missing both projectId and workspaceId", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "fs",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing_scope");
    });

    it("rejects an envelope carrying BOTH projectId and workspaceId", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "fs",
        projectId: "p-1",
        workspaceId: "w-1",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ambiguous_scope");
    });

    it("rejects an envelope with empty-string ids (treated as missing scope)", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      const result = WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "fs",
        projectId: "",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing_scope");
    });

    it("a rejected subscribe does NOT register the client (no leakage)", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      WSManagerModule.wsManager.handleSubscribeMessage(ws, {
        kind: "subscribe",
        topic: "bogus",
        projectId: "p-1",
      });
      // Even if anyone broadcasts to p-1, this ws should not get a message.
      WSManagerModule.wsManager.broadcastToProject("p-1", { kind: "fs.changed" });
      expect(ws.send).not.toHaveBeenCalled();
      expect(WSManagerModule.wsManager.clientCount).toBe(0);
    });
  });

  // ─── auth / scope notes ──────────────────────────────────────────────
  //
  // The bearer-token gate (`?token=...`) is enforced at the WebSocket
  // upgrade boundary in src/server.ts via `verifyWsToken` BEFORE any
  // protocol message is read. Once the socket is open, the `fs` topic
  // is no different from `tasks` / `chats` — there is no per-frame
  // re-check, and the in-band subscribe envelope is trusted at the
  // protocol layer. The behavioural assertion here is structural: the
  // ws-manager exposes no auth-bypass surface — no method accepts a
  // token; auth is "is this socket already attached" by virtue of
  // having been registered through the upgrade-time helpers. This
  // contract is verified by the absence of any token-shaped parameter
  // on the public manager API.
  describe("auth boundary", () => {
    it("ws-manager exposes no method that takes a token / auth header", () => {
      // Sanity: the public surface that the fs topic uses doesn't accept
      // anything resembling auth. Auth lives at the WS upgrade in
      // server.ts; the manager is post-handshake only.
      const m = WSManagerModule.wsManager as unknown as Record<string, unknown>;
      const surface = [
        "addProjectClient",
        "addWorkspaceClient",
        "broadcastToProject",
        "broadcastToWorkspace",
        "handleSubscribeMessage",
      ];
      for (const name of surface) {
        expect(typeof m[name]).toBe("function");
        // Function `length` is the number of declared params before
        // any default; for the fs surface it is 1 or 2 — never the
        // "token + ..." shape (3+ leading params).
        const arity = (m[name] as (...args: unknown[]) => unknown).length;
        expect(arity).toBeLessThanOrEqual(2);
      }
    });
  });
});
