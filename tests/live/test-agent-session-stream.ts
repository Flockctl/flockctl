/**
 * End-to-end live test for AgentSession.run() against the real Claude Code
 * SDK (Haiku 4.5 — fast and cheap). Verifies that:
 *
 *   1. text chunks stream in (the `text` event fires at least once)
 *   2. usage metrics arrive with non-zero token counts
 *   3. a session_id is emitted (so daemon-restart resume would work)
 *   4. the final answer contains the literal "PONG"
 *
 * Skipped (exit 77) when the Claude CLI is not installed/authenticated, so
 * CI without live credentials passes. Run locally with:
 *
 *   FLOCKCTL_LIVE_TESTS=1 npx tsx tests/live/test-agent-session-stream.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/services/agent-session/index.js";

try {
  execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
} catch {
  console.log("  (skipping: claude CLI not installed)");
  process.exit(77);
}

const workingDir = mkdtempSync(join(tmpdir(), "flockctl-live-session-"));

let textCount = 0;
let collectedText = "";
let sawSessionId = false;
let usageInputTokens = 0;
let usageOutputTokens = 0;

const session = new AgentSession({
  chatId: 999_999,
  prompt: "PING",
  model: "claude-haiku-4-5-20251001",
  codebaseContext: "Test scratch directory.",
  workingDir,
  timeoutSeconds: 60,
  permissionMode: "default",
  systemPromptOverride:
    "You are a test bot. Answer with exactly the single word: PONG",
});

session.on("text", (chunk) => {
  textCount += 1;
  collectedText += chunk;
});
session.on("session_id", () => {
  sawSessionId = true;
});
session.on("usage", (m) => {
  usageInputTokens = m.inputTokens;
  usageOutputTokens = m.outputTokens;
});
session.on("error", (err) => {
  console.error("session error:", err);
});

try {
  const metrics = await session.run();

  if (textCount === 0) {
    throw new Error("expected at least one text chunk; got 0");
  }
  if (!/PONG/i.test(collectedText)) {
    throw new Error(`expected PONG in answer, got: ${collectedText.slice(0, 200)}`);
  }
  if (!sawSessionId) {
    throw new Error("session_id event never fired");
  }
  if (usageInputTokens < 1 || usageOutputTokens < 1) {
    throw new Error(
      `expected non-zero usage, got input=${usageInputTokens}, output=${usageOutputTokens}`,
    );
  }
  if (metrics.turns < 1) {
    throw new Error(`expected ≥1 turn, got ${metrics.turns}`);
  }
} finally {
  rmSync(workingDir, { recursive: true, force: true });
}
