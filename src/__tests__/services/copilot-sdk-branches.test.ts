/**
 * Branch-coverage extras for ai/copilot-sdk.ts.
 *
 * Fills the gaps left by copilot-sdk.test.ts + copilot-sdk-extra.test.ts:
 *
 *   - checkCopilotReadiness when SDK is not installed (authenticated=false
 *     branch via `installed ? isCopilotAuthed() : false`)
 *   - poolKeyFor("") → "__env__"
 *   - getOrCreateClient env-fallback branch (no githubToken given)
 *   - canUseTool `decision.behavior === "allow"` → { kind: "approved" } path
 *   - assistant.usage with `data` missing (hits `event?.data ?? {}` path)
 *   - concurrent client creations reuse the same pending promise
 *     (`_clientStartPromises` race path)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createSessionMock = vi.fn<(config: unknown) => void>();
const sendAndWaitMock = vi.fn<(args: { prompt: string }) => Promise<void>>(async () => {});
const disconnectMock = vi.fn<() => Promise<void>>(async () => {});
const stopMock = vi.fn<() => Promise<void>>(async () => {});

class FakeSession {
  handlers = new Map<string, (e: unknown) => void>();
  on(event: string, handler: (e: unknown) => void) {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }
  sendAndWait(args: { prompt: string }) {
    return sendAndWaitMock(args);
  }
  disconnect() {
    return disconnectMock();
  }
}

let lastSession: FakeSession | null = null;
let constructorCount = 0;
let constructorDelayMs = 0;
let lastCtorArgs: Record<string, unknown> | null = null;

class FakeClient {
  constructor(opts: Record<string, unknown>) {
    constructorCount += 1;
    lastCtorArgs = opts;
  }
  async createSession(config: unknown) {
    createSessionMock(config);
    const s = new FakeSession();
    lastSession = s;
    return s;
  }
  async stop() {
    return stopMock();
  }
}

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: new Proxy(FakeClient, {
    construct(target, args) {
      // Optionally delay inside the constructor-returned promise chain
      // inside getOrCreateClient, so concurrent callers can stack up on
      // `_clientStartPromises`. We do this by slowing the dynamic import
      // indirectly: the module's `start` arrow awaits the import then
      // constructs synchronously — so instead we inject the delay inside
      // createSession via sendAndWaitMock. Here we just forward.
      return new (target as any)(...args);
    },
  }),
}));

async function importFresh() {
  vi.resetModules();
  return import("../../services/ai/copilot-sdk.js");
}

beforeEach(() => {
  createSessionMock.mockClear();
  sendAndWaitMock.mockReset();
  sendAndWaitMock.mockImplementation(async () => {});
  disconnectMock.mockClear();
  stopMock.mockClear();
  lastSession = null;
  constructorCount = 0;
  constructorDelayMs = 0;
  lastCtorArgs = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* checkCopilotReadiness — SDK missing branch                                  */
/* -------------------------------------------------------------------------- */

describe("checkCopilotReadiness — installed=false branch", () => {
  it("returns authenticated=false when `node -e require.resolve('@github/copilot-sdk')` exits non-zero", async () => {
    // Mock child_process.execSync so `isCopilotSdkPresent()` sees a failure
    // when it probes for the SDK. That drives the `installed ? … : false`
    // ternary into its RIGHT branch — the previously uncovered arm.
    vi.resetModules();
    vi.doMock("child_process", async (orig) => {
      const actual = await orig<typeof import("child_process")>();
      return {
        ...actual,
        execSync: vi.fn((cmd: string) => {
          if (typeof cmd === "string" && cmd.includes("@github/copilot-sdk")) {
            const err = new Error("MODULE_NOT_FOUND") as Error & { status?: number };
            err.status = 1;
            throw err;
          }
          // Any other execSync call (e.g. `gh auth status`) also fails so
          // authenticated is forced to false.
          throw new Error("unmocked execSync");
        }),
      };
    });
    const mod = await import("../../services/ai/copilot-sdk.js");
    mod.clearCopilotReadinessCache();

    // Ensure env vars don't short-circuit isCopilotAuthed (which wouldn't
    // be called anyway, but just in case).
    const prevGh = process.env.GH_TOKEN;
    const prevGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const r = mod.checkCopilotReadiness();
      expect(r.installed).toBe(false);
      expect(r.authenticated).toBe(false);
      expect(r.ready).toBe(false);
    } finally {
      if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
      if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
      vi.doUnmock("child_process");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pool key + env fallback branches                                            */
/* -------------------------------------------------------------------------- */

describe("client pool — key + env fallback branches", () => {
  it("empty-string githubToken maps to the '__env__' pool key", async () => {
    const mod = await importFresh();
    // Two streams with token='' and token=undefined must share a client.
    sendAndWaitMock.mockImplementation(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const it1 = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "",
    });
    for await (const _ of it1) { void _; }
    const it2 = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      // no githubToken → undefined → also maps to __env__
    });
    for await (const _ of it2) { void _; }
    // Same pool key → FakeClient constructed once.
    expect(constructorCount).toBe(1);
  });

  it("when no githubToken given, resolved token falls back to GH_TOKEN env var", async () => {
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "env-token-xyz";
    try {
      const mod = await importFresh();
      sendAndWaitMock.mockImplementationOnce(async () => {
        lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
      });
      const iter = mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex",
        system: "",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of iter) { void _; }
      // The constructor received the env-var token in `githubToken`.
      expect(lastCtorArgs?.githubToken).toBe("env-token-xyz");
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev;
    }
  });

  it("when no githubToken and no GH_TOKEN, falls back to GITHUB_TOKEN", async () => {
    const prevGh = process.env.GH_TOKEN;
    const prevGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "github-token-abc";
    try {
      const mod = await importFresh();
      sendAndWaitMock.mockImplementationOnce(async () => {
        lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
      });
      const iter = mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex",
        system: "",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of iter) { void _; }
      expect(lastCtorArgs?.githubToken).toBe("github-token-abc");
    } finally {
      if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGithub;
    }
  });

  it("concurrent first-time starts share the same pending-client promise (only one constructor)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementation(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    // Kick two concurrent streams with the same token — if
    // `_clientStartPromises` didn't exist, both would spawn a client.
    const p1 = (async () => {
      for await (const _ of mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "a" }],
        githubToken: "conc-tok",
      })) { void _; }
    })();
    const p2 = (async () => {
      for await (const _ of mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "b" }],
        githubToken: "conc-tok",
      })) { void _; }
    })();
    await Promise.all([p1, p2]);
    expect(constructorCount).toBe(1);
  });
  void constructorDelayMs;
});

/* -------------------------------------------------------------------------- */
/* makePermissionBridge — canUseTool → approved branch                         */
/* -------------------------------------------------------------------------- */

describe("makePermissionBridge — canUseTool allow branch", () => {
  it("maps decision.behavior='allow' to { kind: 'approved' }", async () => {
    const mod = await importFresh();
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    sendAndWaitMock.mockImplementationOnce(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_allow",
      canUseTool,
    });
    for await (const _ of iter) { void _; }
    const cfg = createSessionMock.mock.calls[0]?.[0] as {
      onPermissionRequest: (req: { kind: string; toolName?: string }) => Promise<{ kind: string }>;
    };
    const decision = await cfg.onPermissionRequest({ kind: "shell", toolName: "Bash" });
    expect(canUseTool).toHaveBeenCalled();
    expect(decision).toEqual({ kind: "approved" });
  });

  it("canUseTool without an outer abortSignal still resolves (default AbortController branch)", async () => {
    // The branch `abortSignal ?? new AbortController().signal` is normally
    // exercised only when the caller supplies NO signal.
    const mod = await importFresh();
    const canUseTool = vi.fn(async (_name, _input, ctx: { signal: AbortSignal }) => {
      // Confirm a real AbortSignal was handed over.
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      return { behavior: "allow" as const };
    });
    sendAndWaitMock.mockImplementationOnce(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_no_sig",
      canUseTool,
      // signal NOT provided — the `?? new AbortController().signal` path fires.
    });
    for await (const _ of iter) { void _; }
    const cfg = createSessionMock.mock.calls[0]?.[0] as {
      onPermissionRequest: (req: { kind: string }) => Promise<{ kind: string }>;
    };
    await cfg.onPermissionRequest({ kind: "shell" });
    expect(canUseTool).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* assistant.usage with missing `data` — `event?.data ?? {}` branch            */
/* -------------------------------------------------------------------------- */

describe("assistant.usage — null data branch", () => {
  it("no-ops gracefully on an event with missing .data (`?? {}` fallback)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      // data missing entirely — every `d.<field> !== undefined` guard must
      // be false, so the usage counters stay at 0.
      s.handlers.get("assistant.usage")?.({});
      s.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const out = await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_nodata",
    });
    expect(out.text).toBe("ok");
    expect(out.usage.inputTokens).toBe(0);
    expect(out.usage.outputTokens).toBe(0);
  });
});

describe("shutdownCopilotClient — branches", () => {
  it("drops a named client and calls .stop()", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_shutdown",
    });
    for await (const _ of iter) { void _; }
    expect(constructorCount).toBe(1);
    await mod.shutdownCopilotClient("gho_shutdown");
    expect(stopMock).toHaveBeenCalled();
  });

  it("with no arg drains every client; running again is safe no-op", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementation(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const iter1 = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }], githubToken: "tok-a",
    });
    for await (const _ of iter1) { void _; }
    const iter2 = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }], githubToken: "tok-b",
    });
    for await (const _ of iter2) { void _; }
    await mod.shutdownCopilotClient();
    expect(stopMock).toHaveBeenCalledTimes(2);
    // No clients left; calling with a missing key is a no-op.
    await mod.shutdownCopilotClient("tok-a");
    expect(stopMock).toHaveBeenCalledTimes(2);
  });
});

describe("tool event extractors — branches", () => {
  it("extracts from d.input object when present", async () => {
    const mod = await importFresh();
    const events: unknown[] = [];
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_start")?.({
        data: { toolName: "Bash", input: { command: "ls" } },
      });
      s.handlers.get("tool.execution_complete")?.({
        data: { toolName: "Bash", output: "file list" },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "done" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_tools_input",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }
    expect(events).toContainEqual({ type: "tool_call", toolName: "Bash", content: { command: "ls" } });
    expect(events).toContainEqual({ type: "tool_result", toolName: "Bash", content: "file list" });
  });

  it("falls back to d.arguments and d.name", async () => {
    const mod = await importFresh();
    const events: unknown[] = [];
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_start")?.({
        data: { name: "Write", arguments: { path: "/tmp/x" } },
      });
      s.handlers.get("tool.execution_complete")?.({
        data: { name: "Write", result: "ok" },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "done" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_tools_args",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }
    expect(events).toContainEqual({ type: "tool_call", toolName: "Write", content: { path: "/tmp/x" } });
    expect(events).toContainEqual({ type: "tool_result", toolName: "Write", content: "ok" });
  });

  it("stringifies non-string output/result objects", async () => {
    const mod = await importFresh();
    const events: unknown[] = [];
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_complete")?.({
        data: { toolName: "Edit", output: { lines: 12 } },
      });
      s.handlers.get("tool.execution_end")?.({
        data: { toolName: "Patch", result: { code: 0 } },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "done" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_tools_stringify",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }
    const outputs = (events as Array<{ type: string; content: string }>)
      .filter((e) => e.type === "tool_result")
      .map((e) => e.content);
    expect(outputs).toContain(JSON.stringify({ lines: 12 }));
    expect(outputs).toContain(JSON.stringify({ code: 0 }));
  });

  it("returns defaults when event.data is missing entirely", async () => {
    const mod = await importFresh();
    const events: unknown[] = [];
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      // data completely absent → all extractors hit their null branches.
      s.handlers.get("tool.execution_start")?.({});
      s.handlers.get("tool.execution_complete")?.({});
      s.handlers.get("assistant.message")?.({ data: { content: "done" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_tools_empty",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }
    expect(events).toContainEqual({ type: "tool_call", toolName: "unknown", content: {} });
    expect(events).toContainEqual({ type: "tool_result", toolName: "unknown", content: "" });
  });

  it("tool handler swallows errors and keeps streaming", async () => {
    const mod = await importFresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_start")?.({ data: { toolName: "Bad" } });
      s.handlers.get("tool.execution_complete")?.({ data: { toolName: "Bad" } });
      s.handlers.get("assistant.message")?.({ data: { content: "still done" } });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_tools_throw",
      onEvent: () => { throw new Error("boom"); },
    });
    let text = "";
    for await (const ev of iter) {
      if (ev.type === "text" && ev.text) text += ev.text;
    }
    expect(text).toBe("still done");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("chatViaCopilotSdk — error event branch", () => {
  it("captures an error event into the returned { error } field", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const out = await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex", system: "", messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_err",
    });
    expect(out.error).toContain("boom");
    expect(out.text).toBe("");
  });
});
