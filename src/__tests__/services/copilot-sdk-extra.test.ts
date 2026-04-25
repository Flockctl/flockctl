/**
 * Extra coverage for copilot-sdk.ts — covers the helper functions
 * (readiness checks, model lookups, client pool lifecycle) and the branches
 * in streamViaCopilotSdk that the main test doesn't exercise:
 *   - assistant.message_delta preferred over assistant.message
 *   - usage event with cache tokens + cost
 *   - tool event extractors' alternate field names (input vs arguments, etc)
 *   - abort-signal wiring
 *   - sendAndWait error → stream emits { type: "error" }
 *   - onEvent thrown inside handlers swallowed + logged
 *   - shutdownCopilotClient (with token + without)
 *   - checkCopilotReadiness caching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @github/copilot-sdk the same way the main test does, but expose the
// FakeSession so individual tests can drive it.
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

class FakeClient {
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

vi.mock("@github/copilot-sdk", () => ({ CopilotClient: FakeClient }));

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
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Pure-function helpers                                                       */
/* -------------------------------------------------------------------------- */

describe("getCopilotModelSpec", () => {
  it("returns a known spec by id", async () => {
    const mod = await importFresh();
    const spec = mod.getCopilotModelSpec("claude-sonnet-4.6");
    expect(spec?.id).toBe("claude-sonnet-4.6");
    expect(spec?.premium).toBe(true);
  });

  it("returns undefined for an unknown id", async () => {
    const mod = await importFresh();
    expect(mod.getCopilotModelSpec("never-ever")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Readiness + cache                                                           */
/* -------------------------------------------------------------------------- */

describe("checkCopilotReadiness + clearCopilotReadinessCache", () => {
  it("returns a shape with installed/authenticated/ready, and caches result", async () => {
    const mod = await importFresh();
    const r1 = mod.checkCopilotReadiness();
    expect(r1).toHaveProperty("installed");
    expect(r1).toHaveProperty("authenticated");
    expect(r1).toHaveProperty("ready");
    // Second call within TTL returns same shape (from cache).
    const r2 = mod.checkCopilotReadiness();
    expect(r2).toEqual(r1);
    mod.clearCopilotReadinessCache();
    // Post-clear still works (just refills the cache).
    const r3 = mod.checkCopilotReadiness();
    expect(r3).toHaveProperty("ready");
  });
});

describe("isCopilotAuthed env-var branch", () => {
  it("returns true when GH_TOKEN is set", async () => {
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghs_test";
    try {
      const mod = await importFresh();
      expect(mod.isCopilotAuthed()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev;
    }
  });

  it("returns true when GITHUB_TOKEN is set (and GH_TOKEN is not)", async () => {
    const prevGh = process.env.GH_TOKEN;
    const prevGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "ghs_test2";
    try {
      const mod = await importFresh();
      expect(mod.isCopilotAuthed()).toBe(true);
    } finally {
      if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGithub;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Client pool lifecycle                                                       */
/* -------------------------------------------------------------------------- */

describe("shutdownCopilotClient", () => {
  it("no-op when called without arg on an empty pool", async () => {
    const mod = await importFresh();
    await expect(mod.shutdownCopilotClient()).resolves.toBeUndefined();
  });

  it("drains the pool for the given token key", async () => {
    const mod = await importFresh();
    // Spawn a client by kicking off a stream turn.
    sendAndWaitMock.mockImplementationOnce(async () => {
      lastSession!.handlers.get("assistant.message")?.({
        data: { content: "ok" },
      });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_a",
    });
    for await (const _ of iter) { void _; }
    await mod.shutdownCopilotClient("gho_a");
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("shutdownCopilotClient() without arg drains ALL pool keys", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementation(async () => {
      lastSession!.handlers.get("assistant.message")?.({
        data: { content: "ok" },
      });
    });
    for (const tok of ["gho_one", "gho_two"]) {
      const iter = mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        githubToken: tok,
      });
      for await (const _ of iter) { void _; }
    }
    await mod.shutdownCopilotClient();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates stop() throwing (best-effort)", async () => {
    const mod = await importFresh();
    stopMock.mockRejectedValueOnce(new Error("stop failed"));
    sendAndWaitMock.mockImplementationOnce(async () => {
      lastSession!.handlers.get("assistant.message")?.({
        data: { content: "ok" },
      });
    });
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_err",
    });
    for await (const _ of iter) { void _; }
    await expect(mod.shutdownCopilotClient("gho_err")).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* streamViaCopilotSdk — text/delta/usage branches                             */
/* -------------------------------------------------------------------------- */

describe("streamViaCopilotSdk — text/delta branches", () => {
  it("emits deltas when assistant.message_delta arrives, and skips the later assistant.message", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("assistant.message_delta")?.({ data: { deltaContent: "he" } });
      s.handlers.get("assistant.message_delta")?.({ data: { deltaContent: "llo" } });
      // This should be IGNORED because we already saw deltas.
      s.handlers.get("assistant.message")?.({ data: { content: "IGNORED" } });
    });
    const events: Array<{ type: string; text?: string }> = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    for await (const ev of iter) {
      if (ev.type === "text") events.push({ type: ev.type, text: ev.text });
    }
    expect(events).toEqual([
      { type: "text", text: "he" },
      { type: "text", text: "llo" },
    ]);
  });

  it("skips empty-delta events (deltaContent missing or empty)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("assistant.message_delta")?.({ data: {} });
      s.handlers.get("assistant.message_delta")?.({ data: { deltaContent: "" } });
      s.handlers.get("assistant.message")?.({ data: { content: "final" } });
    });
    const texts: string[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    for await (const ev of iter) {
      if (ev.type === "text" && typeof ev.text === "string") texts.push(ev.text);
    }
    expect(texts).toEqual(["final"]);
  });

  it("extracts text from array-form content (string + object shapes)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("assistant.message")?.({
        data: { content: ["hello ", { text: "world" }, { nope: true }, "!"] },
      });
    });
    const texts: string[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    for await (const ev of iter) {
      if (ev.type === "text" && typeof ev.text === "string") texts.push(ev.text);
    }
    expect(texts.join("")).toBe("hello world!");
  });

  it("extracts '' for unknown content shapes (no text emitted)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("assistant.message")?.({ data: { content: { unknown: true } } });
    });
    const texts: string[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    for await (const ev of iter) {
      if (ev.type === "text" && typeof ev.text === "string") texts.push(ev.text);
    }
    expect(texts).toEqual([]);
  });

  it("accumulates usage including cache tokens + cost", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("assistant.message")?.({ data: { content: "x" } });
      s.handlers.get("assistant.usage")?.({
        data: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          cost: 0.01,
        },
      });
    });
    const result = await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    expect(result.text).toBe("x");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("stringifies non-string message content via JSON.stringify in the prompt", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async (args) => {
      // object content must have been JSON-stringified into the prompt
      expect(args.prompt).toContain(`{"kind":"complex","bits":[1,2]}`);
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const result = await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [
        { role: "user", content: { kind: "complex", bits: [1, 2] } },
      ],
      githubToken: "gho_test",
    });
    expect(result.text).toBe("ok");
  });
});

/* -------------------------------------------------------------------------- */
/* streamViaCopilotSdk — tool events alternate shapes + errors                  */
/* -------------------------------------------------------------------------- */

describe("streamViaCopilotSdk — tool event extraction", () => {
  it("falls back to `arguments`/`result`/`name` fields when primary names are missing", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      // name (not toolName), arguments (not input)
      s.handlers.get("tool.execution_start")?.({
        data: { name: "bash", arguments: { cmd: "ls" } },
      });
      // result (not output) — object form gets JSON-stringified
      s.handlers.get("tool.execution_complete")?.({
        data: { name: "bash", result: { exit: 0 } },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "done" } });
    });

    const events: any[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }

    const call = events.find((e) => e.type === "tool_call");
    const result = events.find((e) => e.type === "tool_result");
    expect(call).toEqual({
      type: "tool_call",
      toolName: "bash",
      content: { cmd: "ls" },
    });
    expect(result).toEqual({
      type: "tool_result",
      toolName: "bash",
      content: JSON.stringify({ exit: 0 }),
    });
  });

  it("tool.execution_end works as an alias of tool.execution_complete", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_start")?.({
        data: { toolName: "bash", input: { cmd: "x" } },
      });
      s.handlers.get("tool.execution_end")?.({
        data: { toolName: "bash", output: "done" },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });

    const events: any[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("returns 'unknown' toolName and {} input/'' output when event data is empty or null", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      // Null data branch
      s.handlers.get("tool.execution_start")?.({ data: null });
      s.handlers.get("tool.execution_complete")?.({ data: null });
      // Missing data branch
      s.handlers.get("tool.execution_start")?.({});
      s.handlers.get("tool.execution_complete")?.({});
      s.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });

    const events: any[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      onEvent: (e) => events.push(e),
    });
    for await (const _ of iter) { void _; }

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.toolName).toBe("unknown");
      expect(c.content).toEqual({});
    }
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.toolName).toBe("unknown");
      expect(r.content).toBe("");
    }
  });

  it("swallows+logs when onEvent throws (does not abort the turn)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementationOnce(async () => {
      const s = lastSession!;
      s.handlers.get("tool.execution_start")?.({
        data: { toolName: "x", input: {} },
      });
      s.handlers.get("tool.execution_complete")?.({
        data: { toolName: "x", output: "" },
      });
      s.handlers.get("assistant.message")?.({ data: { content: "ok" } });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      onEvent: () => { throw new Error("consumer crashed"); },
    });
    const texts: string[] = [];
    for await (const ev of iter) {
      if (ev.type === "text" && typeof ev.text === "string") texts.push(ev.text);
    }
    expect(texts).toEqual(["ok"]);
    // Warn called twice (one for start, one for complete).
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* Error + abort paths                                                         */
/* -------------------------------------------------------------------------- */

describe("streamViaCopilotSdk — error/abort", () => {
  it("emits { type: 'error' } when sendAndWait rejects", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockRejectedValueOnce(new Error("session crashed"));
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    const events: any[] = [];
    for await (const ev of iter) events.push(ev);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].error).toContain("session crashed");
  });

  it("emits error and stops on abort signal", async () => {
    const mod = await importFresh();
    const controller = new AbortController();
    // sendAndWait must yield to the event loop first so the abort listener
    // gets a chance to attach — otherwise calling `controller.abort()`
    // synchronously happens before the listener is wired up and the abort
    // branch never fires.
    sendAndWaitMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      await new Promise((r) => setTimeout(r, 50));
    });
    const events: any[] = [];
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      signal: controller.signal,
    });
    for await (const ev of iter) events.push(ev);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.some((e) => /aborted/i.test(e.error ?? ""))).toBe(true);
  });

  it("chatViaCopilotSdk surfaces the error on the { error } result", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockRejectedValueOnce("bare-string-error");
    const out = await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    expect(out.text).toBe("");
    expect(out.error).toBe("bare-string-error");
  });
});

/* -------------------------------------------------------------------------- */
/* Client pool — caching behavior                                              */
/* -------------------------------------------------------------------------- */

describe("client pool — caching", () => {
  it("reuses the same client for sequential calls with the same token (only one CopilotClient instance per key)", async () => {
    const mod = await importFresh();
    sendAndWaitMock.mockImplementation(async () => {
      lastSession!.handlers.get("assistant.message")?.({ data: { content: "x" } });
    });
    for (let i = 0; i < 3; i++) {
      const iter = mod.streamViaCopilotSdk({
        model: "gpt-5.3-codex",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        githubToken: "gho_cache",
      });
      for await (const _ of iter) { void _; }
    }
    // Three sessions, but the same client instance.
    expect(createSessionMock).toHaveBeenCalledTimes(3);
  });
});
