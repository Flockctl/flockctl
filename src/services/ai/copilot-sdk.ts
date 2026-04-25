/**
 * GitHub Copilot SDK integration helpers.
 *
 * Mirrors the shape of `claude-cli.ts` so the `CopilotProvider` in
 * `services/agents/copilot/provider.ts` stays a thin wrapper, and unit tests
 * can mock this module directly (same pattern as `vi.mock("claude-cli")`).
 *
 * Design notes (from `scripts/copilot-spike.ts` measurements, 2026-04-21):
 *   - Client spawn costs ~1.7–2.1s, so we keep a module-level warm client
 *     pool of size 1 and reuse it across sessions.
 *   - SDK 0.2.2 emits `assistant.message_delta` only for some models/configs.
 *     `assistant.message` is always emitted with the full content at the end.
 *     We subscribe to BOTH and surface whichever arrives — deltas when
 *     available, else a single chunk on message completion.
 *   - Billing is per-prompt (not per-session). Provider callers should batch
 *     work into a single `chat()` / `streamChat()` turn, not chain follow-ups.
 */

import { execSync } from "child_process";
import type {
  StreamChatEvent,
  PermissionHandler,
  AgentUsage,
  AgentStreamEvent,
} from "../agents/types.js";

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export interface CopilotModelSpec {
  id: string;
  name: string;
  /** Premium-request multiplier (1 = standard, 0 = free, >1 = expensive). */
  multiplier: number;
  contextWindow?: number;
  maxTokens?: number;
  /** True when GitHub bills this model against the premium-request quota. */
  premium: boolean;
}

/**
 * Known Copilot models — snapshot collected from `client.listModels()` on
 * 2026-04-21 for a Pro+ account. Not exhaustive; the actual set depends on
 * the caller's entitlement. This list exists so `listModels()` works
 * synchronously (matches `AgentProvider` contract) and so tests have a
 * stable baseline. At runtime `refreshModels()` can replace it.
 */
export const COPILOT_MODELS: CopilotModelSpec[] = [
  { id: "claude-opus-4.7", name: "Claude Opus 4.7", multiplier: 7.5, premium: true },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", multiplier: 1, premium: true },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1, premium: true },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", multiplier: 0.33, premium: true },
  { id: "gpt-5.4", name: "GPT-5.4", multiplier: 1, premium: true },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", multiplier: 1, premium: true },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex", multiplier: 1, premium: true },
  { id: "gpt-5.2", name: "GPT-5.2", multiplier: 1, premium: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", multiplier: 0.33, premium: true },
  { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0, premium: false },
  { id: "gpt-4.1", name: "GPT-4.1", multiplier: 0, premium: false },
];

export function getCopilotModelSpec(id: string): CopilotModelSpec | undefined {
  return COPILOT_MODELS.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Readiness checks
// ---------------------------------------------------------------------------

let _readinessCache: { installed: boolean; authenticated: boolean; ts: number } | null =
  null;
const READINESS_TTL_MS = 30_000;

export function clearCopilotReadinessCache(): void {
  _readinessCache = null;
}

/** SDK installed iff `@github/copilot-sdk` resolves. */
export function isCopilotSdkPresent(): boolean {
  try {
    // `require.resolve` is not available in ESM without createRequire; use
    // dynamic-import-then-throw instead. We only care about presence, not
    // behaviour, so a sync `execSync` check on the path is simpler.
    execSync("node -e \"require.resolve('@github/copilot-sdk')\"", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticated iff EITHER `$GH_TOKEN` / `$GITHUB_TOKEN` is set with non-empty
 * value, OR `gh auth status` exits 0. We do not try to validate that the
 * token actually has Copilot access — that would cost a network round-trip
 * and the SDK will fail fast on session create anyway.
 */
export function isCopilotAuthed(): boolean {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function checkCopilotReadiness(): {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
} {
  const now = Date.now();
  if (_readinessCache && now - _readinessCache.ts < READINESS_TTL_MS) {
    return {
      installed: _readinessCache.installed,
      authenticated: _readinessCache.authenticated,
      ready: _readinessCache.installed && _readinessCache.authenticated,
    };
  }
  const installed = isCopilotSdkPresent();
  const authenticated = installed ? isCopilotAuthed() : false;
  _readinessCache = { installed, authenticated, ts: now };
  return { installed, authenticated, ready: installed && authenticated };
}

// ---------------------------------------------------------------------------
// Client pool — one warm client, lazily spawned
// ---------------------------------------------------------------------------

// We avoid a static `import` of the SDK so that
//   (a) `typecheck` still passes when the dep is excluded in lean builds,
//   (b) tests that `vi.mock("../copilot-sdk")` never touch the real SDK.
type CopilotClient = {
  createSession: (opts: Record<string, unknown>) => Promise<CopilotSession>;
  stop?: () => Promise<void>;
};
type CopilotSession = {
  on: (a: unknown, b?: unknown) => () => void;
  sendAndWait: (opts: { prompt: string }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
};

/**
 * Per-token client pool. Different AI Provider Keys map to different GitHub
 * tokens, so the pool is keyed by the token value. An empty/undefined token
 * falls back to `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth status`; that entry
 * lives under the sentinel key `"__env__"`.
 */
const _clients = new Map<string, CopilotClient>();
const _clientStartPromises = new Map<string, Promise<CopilotClient>>();

function poolKeyFor(token: string | undefined): string {
  return token && token.length > 0 ? token : "__env__";
}

async function getOrCreateClient(
  githubToken: string | undefined,
): Promise<CopilotClient> {
  const key = poolKeyFor(githubToken);
  const existing = _clients.get(key);
  if (existing) return existing;
  const pending = _clientStartPromises.get(key);
  if (pending) return pending;

  const start = (async () => {
    const mod = (await import("@github/copilot-sdk")) as unknown as {
      CopilotClient: new (opts: Record<string, unknown>) => CopilotClient;
    };
    const resolvedToken =
      githubToken && githubToken.length > 0
        ? githubToken
        : (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
    const client = new mod.CopilotClient({
      githubToken: resolvedToken,
      // SDK 0.2.2 vocab: none | error | warning | info | debug | all | default
      logLevel: process.env.COPILOT_LOG_LEVEL ?? "warning",
    });
    _clients.set(key, client);
    return client;
  })();

  _clientStartPromises.set(key, start);
  try {
    return await start;
  } finally {
    _clientStartPromises.delete(key);
  }
}

/** For tests / shutdown — drops the pooled client and forces a fresh spawn. */
export async function shutdownCopilotClient(
  githubToken?: string,
): Promise<void> {
  if (githubToken !== undefined) {
    const key = poolKeyFor(githubToken);
    const c = _clients.get(key);
    _clients.delete(key);
    _clientStartPromises.delete(key);
    if (c?.stop) {
      try {
        await c.stop();
      } catch {
        /* best-effort */
      }
    }
    return;
  }
  // No arg → drain all clients.
  const all = Array.from(_clients.values());
  _clients.clear();
  _clientStartPromises.clear();
  await Promise.all(
    all.map(async (c) => {
      /* v8 ignore next — every Client created via the SDK exposes `.stop`;
         the guard exists only for a pathological mock shape. */
      if (c.stop) {
        try {
          await c.stop();
        } catch {
          /* best-effort */
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Copilot sessions take a single `prompt: string` per turn. We flatten the
 * Flockctl message list into one prompt, prefixed with the system message.
 * This matches the spike's finding that one prompt == one premium request,
 * so we never want to split a logical task into multiple turns.
 */
function buildPrompt(
  system: string,
  messages: Array<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];
  if (system) {
    parts.push(`[system]\n${system.trim()}\n`);
  }
  for (const msg of messages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    parts.push(`[${msg.role}]\n${text}\n`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Session-events → Flockctl-events mapping
// ---------------------------------------------------------------------------

interface AssistantUsageEventData {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

interface AssistantMessageEventData {
  content?: unknown;
}

interface AssistantDeltaEventData {
  deltaContent?: string;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { text?: string } | string) =>
        typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "",
      )
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Streaming + non-streaming entry points
// ---------------------------------------------------------------------------

type SdkPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
type CopilotPermissionDecision = { kind: "approved" | "denied-by-rules"; rules?: unknown[] };
type CopilotPermissionRequest = { kind: string; toolName?: string; fileName?: string };

/**
 * Map an SDK permission mode to a Copilot permission handler. Copilot SDK 0.2.2
 * has no `approvalMode` parameter — the GitHub UI's "Default / Bypass / Autopilot"
 * toggles just swap the `onPermissionRequest` implementation, so we mirror
 * Claude Code's four modes the same way. `PermissionRequest.kind` is one of
 * `shell | write | mcp | read | url | custom-tool`, which is what we dispatch on.
 */
function modeHandler(mode: SdkPermissionMode): (req: CopilotPermissionRequest) => CopilotPermissionDecision {
  switch (mode) {
    case "bypassPermissions":
      return () => ({ kind: "approved" });
    case "acceptEdits":
      return (req) =>
        req.kind === "read" || req.kind === "write"
          ? { kind: "approved" }
          : { kind: "denied-by-rules", rules: [] };
    case "plan":
      return (req) =>
        req.kind === "read"
          ? { kind: "approved" }
          : { kind: "denied-by-rules", rules: [] };
    case "default":
      return () => ({ kind: "denied-by-rules", rules: [] });
  }
}

/**
 * Permission handler for Copilot tool invocations. Precedence:
 *   1. explicit `canUseTool` (the UI-backed prompt pipeline);
 *   2. `sdkPermissionMode` → synthesized handler (bypass / acceptEdits / plan / default);
 *   3. neither → approve-all, matching ai-client.ts's default for Claude Code
 *      when no canUseTool is supplied.
 */
function makePermissionBridge(
  canUseTool: PermissionHandler | undefined,
  sdkPermissionMode: SdkPermissionMode | undefined,
  abortSignal?: AbortSignal,
) {
  if (canUseTool) {
    return async (request: CopilotPermissionRequest): Promise<CopilotPermissionDecision> => {
      const signal = abortSignal ?? new AbortController().signal;
      const decision = await canUseTool(
        request.toolName ?? request.kind,
        /* v8 ignore next — `request` is always a non-null object at this
           point (the SDK only invokes callbacks with shaped payloads); the
           ?? {} fallback is defensive typing glue. */
        (request as Record<string, unknown>) ?? {},
        {
          signal,
          toolUseID: `copilot-${request.kind}-${Date.now()}`,
        },
      );
      return decision.behavior === "allow"
        ? { kind: "approved" }
        : { kind: "denied-by-rules", rules: [] };
    };
  }
  const synth = modeHandler(sdkPermissionMode ?? "bypassPermissions");
  return async (request: CopilotPermissionRequest): Promise<CopilotPermissionDecision> =>
    synth(request);
}

export interface StreamViaCopilotOptions {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  resumeSessionId?: string;
  signal?: AbortSignal;
  /** If supplied, receives permission requests from the Copilot agent. */
  canUseTool?: PermissionHandler;
  /**
   * Maps to the GitHub UI's approval presets: `bypassPermissions` = Bypass /
   * Autopilot (approve all), `acceptEdits` = auto-approve read+write only,
   * `plan` = read-only, `default` = deny-unless-caller-asks. Ignored when
   * `canUseTool` is provided (the UI pipeline takes over).
   */
  sdkPermissionMode?: SdkPermissionMode;
  /**
   * GitHub token (from the AI Provider Key's `keyValue`). When absent, falls
   * back to `$GH_TOKEN` / `$GITHUB_TOKEN` / `gh auth status`.
   */
  githubToken?: string;
  /**
   * Session working directory. Forwarded to `client.createSession` as
   * `workingDirectory` so Copilot's tool calls and cwd-derived context
   * resolve to the chat's project/workspace path instead of the daemon's
   * `process.cwd()`. Without this every chat leaks Flockctl's own repo.
   */
  workingDirectory?: string;
  /**
   * Side-channel for intermediate events that don't fit the minimal
   * `StreamChatEvent` shape the async iterator yields (which only carries
   * text/done/error). Copilot SDK 0.2.x emits tool invocations as
   * `tool.execution_start` / `tool.execution_complete` events; we forward
   * them as `AgentStreamEvent` so the chat route can render each tool as a
   * live block in the same order as Claude Code's stream, without waiting
   * for the final message re-fetch.
   */
  onEvent?: (event: AgentStreamEvent) => void;
}

/**
 * Streaming chat against a single Copilot session. Maps SDK events to the
 * `StreamChatEvent` shape used by the rest of Flockctl.
 */
export async function* streamViaCopilotSdk(
  opts: StreamViaCopilotOptions,
): AsyncIterable<StreamChatEvent> {
  const client = await getOrCreateClient(opts.githubToken);
  const session = await client.createSession({
    model: opts.model,
    onPermissionRequest: makePermissionBridge(
      opts.canUseTool,
      opts.sdkPermissionMode,
      opts.signal,
    ),
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
  });

  // We buffer events into a queue so the async-iterator can await them.
  const queue: StreamChatEvent[] = [];
  const waiters: Array<(e: StreamChatEvent | null) => void> = [];
  let done = false;

  function push(e: StreamChatEvent) {
    const w = waiters.shift();
    if (w) w(e);
    else queue.push(e);
  }
  function close() {
    done = true;
    for (const w of waiters) w(null);
    waiters.length = 0;
  }
  function next(): Promise<StreamChatEvent | null> {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    /* v8 ignore next — `done` becoming true while the queue is empty is
       only reachable through a race in the close() path that the tests
       don't reliably trigger; the guard prevents a dangling waiter. */
    if (done) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  }

  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let usageCost = 0;
  let sawDelta = false;

  // Delta path (preferred when the model supports streaming).
  session.on("assistant.message_delta", (event: { data?: AssistantDeltaEventData }) => {
    const chunk = event?.data?.deltaContent ?? "";
    if (!chunk) return;
    sawDelta = true;
    push({ type: "text", text: chunk });
  });

  // Fallback path: SDK 0.2.2 frequently emits only the final `assistant.message`.
  session.on("assistant.message", (event: { data?: AssistantMessageEventData }) => {
    if (sawDelta) return; // already streamed; avoid double-emit
    const text = extractMessageText(event?.data?.content);
    if (text) push({ type: "text", text });
  });

  session.on("assistant.usage", (event: { data?: AssistantUsageEventData }) => {
    const d = event?.data ?? {};
    if (d.inputTokens !== undefined) usage.inputTokens += d.inputTokens;
    if (d.outputTokens !== undefined) usage.outputTokens += d.outputTokens;
    if (d.cacheReadTokens !== undefined) usage.cacheReadInputTokens += d.cacheReadTokens;
    if (d.cacheWriteTokens !== undefined)
      usage.cacheCreationInputTokens += d.cacheWriteTokens;
    if (d.cost !== undefined) usageCost += d.cost;
  });

  // Tool invocation events. SDK 0.2.x emits `tool.execution_start` right
  // before a tool runs (with toolName + input) and `tool.execution_complete`
  // (or `tool.execution_end` on some SDK builds) after the tool returns. We
  // surface both via `onEvent` so the chat route can push them onto the SSE
  // stream as inline blocks, matching Claude Code's live rendering. Without
  // this Copilot chats render as a single text blob on reload with no sign
  // of what tools were actually invoked mid-turn.
  //
  // Listeners are wrapped in try/catch so a malformed event or unknown
  // payload shape never aborts the turn — we log once and keep streaming.
  if (opts.onEvent) {
    const onEvent = opts.onEvent;
    const extractToolInput = (data: unknown): Record<string, unknown> => {
      if (!data || typeof data !== "object") return {};
      const d = data as Record<string, unknown>;
      if (d.input && typeof d.input === "object") return d.input as Record<string, unknown>;
      if (d.arguments && typeof d.arguments === "object") return d.arguments as Record<string, unknown>;
      return {};
    };
    const extractToolOutput = (data: unknown): string => {
      if (!data || typeof data !== "object") return "";
      const d = data as Record<string, unknown>;
      if (typeof d.output === "string") return d.output;
      if (typeof d.result === "string") return d.result;
      if (d.output !== undefined) return JSON.stringify(d.output);
      if (d.result !== undefined) return JSON.stringify(d.result);
      return "";
    };
    const extractToolName = (data: unknown): string => {
      if (!data || typeof data !== "object") return "unknown";
      const d = data as Record<string, unknown>;
      if (typeof d.toolName === "string") return d.toolName;
      /* v8 ignore next — the copilot SDK always emits tool events with a
         `toolName` string; the `name` fallback is defensive. */
      if (typeof d.name === "string") return d.name;
      return "unknown";
    };

    session.on("tool.execution_start", (event: { data?: unknown }) => {
      try {
        onEvent({
          type: "tool_call",
          toolName: extractToolName(event?.data),
          content: extractToolInput(event?.data),
        });
      } catch (err) {
        console.warn("[copilot-sdk] tool.execution_start forward failed:", err);
      }
    });
    const resultHandler = (event: { data?: unknown }) => {
      try {
        onEvent({
          type: "tool_result",
          toolName: extractToolName(event?.data),
          content: extractToolOutput(event?.data),
        });
      } catch (err) {
        console.warn("[copilot-sdk] tool result forward failed:", err);
      }
    };
    session.on("tool.execution_complete", resultHandler);
    session.on("tool.execution_end", resultHandler);
  }

  const prompt = buildPrompt(opts.system, opts.messages);

  // Kick off the turn; resolve when `sendAndWait` returns (== session.idle).
  const run = (async () => {
    try {
      await session.sendAndWait({ prompt });
      push({
        type: "done",
        sessionId: undefined, // SDK does not expose a sessionId we can resume
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalCostUsd: 0, // Copilot is flat-rate subscription, not per-token USD
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      push({ type: "error", error: msg });
    } finally {
      close();
    }
  })();

  // Abort wiring.
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      push({ type: "error", error: "Aborted by caller" });
      close();
    });
  }

  try {
    while (true) {
      const ev = await next();
      /* v8 ignore next — next() only returns null when close() fires before
         the "done" sentinel arrives; the graceful path terminates on the
         subsequent `ev.type === "done"` break instead. */
      if (!ev) break;
      yield ev;
      if (ev.type === "done" || ev.type === "error") break;
    }
  } finally {
    await run.catch(() => {});
    try {
      await session.disconnect?.();
    } catch {
      /* best-effort */
    }
    // Usage observability: we deliberately do NOT dollarize usageCost since
    // the caller's plan determines its value. Caller can look it up via
    // `getCopilotModelSpec(model).multiplier` if they need a quota estimate.
    void usageCost;
  }
}

/**
 * Non-streaming convenience wrapper — drains `streamViaCopilotSdk` into a
 * single `{ text, usage }` result. Used by `CopilotProvider.chat()`.
 */
export async function chatViaCopilotSdk(
  opts: StreamViaCopilotOptions,
): Promise<{ text: string; usage: AgentUsage; error?: string }> {
  let text = "";
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let error: string | undefined;

  for await (const ev of streamViaCopilotSdk(opts)) {
    if (ev.type === "text" && ev.text) text += ev.text;
    else if (ev.type === "done" && ev.usage) {
      usage.inputTokens = ev.usage.inputTokens;
      usage.outputTokens = ev.usage.outputTokens;
      /* v8 ignore next — the error branch is only reached when the SDK
         surfaces a terminal error before "done"; the surrounding branches
         are exercised by the streaming tests. */
    } else if (ev.type === "error") {
      error = ev.error;
    }
  }

  return { text, usage, error };
}
