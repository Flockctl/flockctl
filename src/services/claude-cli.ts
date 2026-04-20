import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { getFlockctlHome } from "../config.js";

// ─── Tilde expansion ───

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    /* v8 ignore next — bare "~" with no slash is rare and only impacts string ops */
    return p.replace("~", homedir());
  }
  return p;
}

// ─── Readiness (cached 30 sec) ───

let cachedBinaryPresent: boolean | null = null;
let cachedAuthed: boolean | null = null;
let lastCheckMs = 0;
const CHECK_INTERVAL_MS = 30_000;

function refreshCache(): void {
  const now = Date.now();
  if (cachedBinaryPresent !== null && now - lastCheckMs < CHECK_INTERVAL_MS) return;
  lastCheckMs = now;

  // 1. Check binary
  try {
    execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
    cachedBinaryPresent = true;
  } catch {
    cachedBinaryPresent = false;
    cachedAuthed = false;
    return;
  }

  // 2. Check auth
  try {
    const output = execFileSync("claude", ["auth", "status"], { timeout: 5_000, stdio: "pipe" })
      .toString().toLowerCase();
    cachedAuthed = !(/not logged in|no credentials|unauthenticated|not authenticated/i.test(output));
  } catch {
    cachedAuthed = false;
  }
}

export function isClaudeBinaryPresent(): boolean {
  refreshCache();
  return cachedBinaryPresent ?? false;
}

export function isClaudeCodeAuthed(): boolean {
  refreshCache();
  return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

export function isClaudeCodeReady(): boolean {
  refreshCache();
  return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

export function clearReadinessCache(): void {
  cachedBinaryPresent = null;
  cachedAuthed = null;
  lastCheckMs = 0;
}

// ─── Claude binary resolution ───

let cachedClaudePath: string | null = null;

function getClaudePath(): string {
  if (cachedClaudePath) return cachedClaudePath;
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    cachedClaudePath = execSync(cmd, { timeout: 5_000, stdio: "pipe" }).toString().trim().split(/\r?\n/)[0];
  } catch {
    /* v8 ignore next — fallback when `which` shells out unsuccessfully */
    cachedClaudePath = "claude"; // fallback to PATH
  }
  return cachedClaudePath;
}

// ─── Models (zero cost — covered by subscription) ───

export const CLAUDE_CODE_MODELS = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7 (via Claude Code)", contextWindow: 200_000, maxTokens: 128_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (via Claude Code)", contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (via Claude Code)", contextWindow: 200_000, maxTokens: 64_000 },
];

// ─── Stream adapter (dynamic import SDK) ───

interface StreamContext {
  model: string;
  system: string;
  messages: Array<{ role: string; content: any }>;
  tools?: any[];
  max_tokens?: number;
  signal?: AbortSignal;
  configDir?: string;
  /** Working directory for Claude Code (defaults to ~/flockctl) */
  cwd?: string;
  /** Claude Code session ID to resume (continues existing conversation) */
  resumeSessionId?: string;
}

/**
 * Streaming via Claude Agent SDK — delegates inference to local Claude Code.
 * SDK is loaded dynamically (optional dependency).
 */
export async function* streamViaClaudeAgentSDK(
  opts: StreamContext,
): AsyncGenerator<{ type: string; text?: string; toolCall?: any; usage?: any; sessionId?: string }> {
  const sdkModule = "@anthropic-ai/claude-agent-sdk";
  let sdk;
  try {
    sdk = await import(/* webpackIgnore: true */ sdkModule);
  } catch {
    /* v8 ignore next — only triggered if SDK is missing at runtime */
    throw new Error("@anthropic-ai/claude-agent-sdk is not installed. Run: npm install @anthropic-ai/claude-agent-sdk");
  }

  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // If resuming an existing session, only send the latest user message
  const isResume = !!opts.resumeSessionId;
  const prompt = getLastUserMessage(opts.messages);

  const queryResult = sdk.query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: getClaudePath(),
      model: opts.model,
      systemPrompt: opts.system || undefined,
      includePartialMessages: true,
      persistSession: true,
      cwd: opts.cwd || getFlockctlHome(),
      permissionMode: "bypassPermissions",
      abortController: controller,
      ...(isResume ? { resume: opts.resumeSessionId } : {}),
      ...(opts.configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: expandTilde(opts.configDir) } } : {}),
    },
  });

  for await (const msg of queryResult) {
    switch (msg.type) {
      case "stream_event": {
        const event = msg.event;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
        break;
      }
      case "result": {
        yield {
          type: "done",
          sessionId: msg.session_id,
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            totalCostUsd: msg.total_cost_usd ?? 0,
          },
        };
        return;
      }
    }
  }
}

/**
 * Rename a Claude Code session (sets custom title visible in `claude` CLI).
 */
export async function renameClaudeSession(sessionId: string, title: string): Promise<void> {
  const sdkModule = "@anthropic-ai/claude-agent-sdk";
  let sdk;
  try {
    sdk = await import(/* webpackIgnore: true */ sdkModule);
  } catch {
    /* v8 ignore next — only triggered if SDK is missing at runtime */
    return; // SDK not available — skip silently
  }
  try {
    await sdk.renameSession(sessionId, title);
  } catch {
    // best-effort — don't break the flow if rename fails
  }
}

function getLastUserMessage(messages: Array<{ role: string; content: any }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return typeof messages[i].content === "string" ? messages[i].content : JSON.stringify(messages[i].content);
    }
  }
  return "";
}
