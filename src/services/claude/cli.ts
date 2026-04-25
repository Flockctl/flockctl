import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { getFlockctlHome } from "../../config/index.js";

// ─── Tilde expansion ───

/* v8 ignore start — helper only reached when configDir is passed into streamViaClaudeAgentSDK, which requires the optional SDK installed at runtime */
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}
/* v8 ignore stop */

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
  /* v8 ignore next — refreshCache always assigns a boolean; ?? fallback is defensive */
  return cachedBinaryPresent ?? false;
}

export function isClaudeCodeAuthed(): boolean {
  refreshCache();
  /* v8 ignore next — refreshCache always assigns both flags; ?? fallbacks are defensive */
  return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

export function isClaudeCodeReady(): boolean {
  refreshCache();
  /* v8 ignore next — refreshCache always assigns both flags; ?? fallbacks are defensive */
  return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

export function clearReadinessCache(): void {
  cachedBinaryPresent = null;
  cachedAuthed = null;
  lastCheckMs = 0;
}

// ─── Claude binary resolution ───

let cachedClaudePath: string | null = null;

/* v8 ignore start — reached only via streamViaClaudeAgentSDK, which requires the optional SDK installed at runtime; win32 arm is intentionally unreachable since Flockctl does not support Windows (CLAUDE.md rule 4) */
function getClaudePath(): string {
  if (cachedClaudePath) return cachedClaudePath;
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const first = execSync(cmd, { timeout: 5_000, stdio: "pipe" }).toString().trim().split(/\r?\n/)[0];
    cachedClaudePath = first && first.length > 0 ? first : "claude";
  } catch {
    cachedClaudePath = "claude"; // fallback to PATH
  }
  return cachedClaudePath;
}
/* v8 ignore stop */

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
  /**
   * MCP servers to expose to the SDK. Pass-through to the Claude Agent SDK's
   * `mcpServers` option — the SDK does NOT auto-read `.mcp.json` from `cwd`,
   * so globally-registered flockctl MCP servers only reach the agent when
   * forwarded explicitly here.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
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

  const hasMcpServers = !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;

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
      ...(hasMcpServers ? { mcpServers: opts.mcpServers } : {}),
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
    const msg = messages[i];
    if (msg && msg.role === "user") {
      return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    }
  }
  return "";
}
