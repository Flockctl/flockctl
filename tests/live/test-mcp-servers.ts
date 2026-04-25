/**
 * Live regression test for the MCP-forwarding fix.
 *
 * Background: flockctl used to rely on Claude CLI reading `.mcp.json` from
 * cwd. That works for the interactive CLI but the Claude Agent SDK (which
 * flockctl actually uses under the hood) does NOT auto-read `.mcp.json` — it
 * only honours MCP servers passed explicitly via the `mcpServers` option.
 * As a result, globally-registered flockctl MCPs (`~/flockctl/mcp/<name>.json`)
 * never reached the agent: tool calls to `mcp__<name>__*` returned "tool not
 * found".
 *
 * This test pins that contract end-to-end:
 *   1. Spin up a tiny in-repo stdio MCP server (`mcp-fixture.ts`).
 *   2. Pass it to `streamViaClaudeAgentSDK` via the new `mcpServers` option.
 *   3. Ask Haiku to call `mcp__flockctl-live-test__flockctl_live_ping` and
 *      echo the returned text.
 *   4. Assert the sentinel string comes back in the streamed output.
 *
 * If the SDK never received `mcpServers`, the tool would be invisible to the
 * model and the sentinel would never appear — exactly the bug we just fixed.
 *
 * Skipped (exit 77) when the Claude CLI is not installed or not authenticated.
 * Run locally with:
 *
 *   FLOCKCTL_LIVE_TESTS=1 npx tsx tests/live/test-mcp-servers.ts
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamViaClaudeAgentSDK } from "../../src/services/claude/cli.js";
import { FIXTURE_SENTINEL, FIXTURE_TOOL_NAME } from "./mcp-fixture.js";

try {
  execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
} catch {
  console.log("  (skipping: claude CLI not installed)");
  process.exit(77);
}

// Resolve absolute paths so the spawned MCP server process can be found
// regardless of Claude SDK's chosen cwd.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "mcp-fixture.ts");
const tsxBin = (() => {
  try {
    return execFileSync("node", [
      "-e",
      "process.stdout.write(require.resolve('tsx/cli'))",
    ], { cwd: join(here, "..", ".."), encoding: "utf8" }).trim();
  } catch {
    return "tsx"; // fall back to PATH lookup
  }
})();

const MCP_SERVER_NAME = "flockctl-live-test";

const iter = streamViaClaudeAgentSDK({
  model: "claude-haiku-4-5-20251001",
  system:
    `You are a test harness. Call the tool mcp__${MCP_SERVER_NAME}__${FIXTURE_TOOL_NAME} ` +
    `exactly once with no arguments, then respond with ONLY the exact text that tool returned. ` +
    `Do not add quotes, punctuation, or explanation.`,
  messages: [
    {
      role: "user",
      content:
        `Invoke the MCP tool now and echo its output verbatim. The tool lives on the ` +
        `${MCP_SERVER_NAME} MCP server.`,
    },
  ],
  mcpServers: {
    [MCP_SERVER_NAME]: {
      type: "stdio",
      command: "node",
      // tsx/cli is a Node-runnable JS shim — safer across Node versions than
      // relying on a `tsx` shell wrapper on PATH.
      args: [tsxBin, fixturePath],
    },
  },
});

let collected = "";
let sawDone = false;
let sessionId: string | undefined;

try {
  for await (const ev of iter) {
    if (ev.type === "text" && ev.text) collected += ev.text;
    if (ev.type === "done") {
      sawDone = true;
      sessionId = ev.sessionId;
    }
  }
} catch (err) {
  console.error("stream error:", err);
  process.exit(1);
}

if (!sawDone) {
  throw new Error("stream ended without a `done` event");
}
if (!sessionId) {
  throw new Error("no sessionId emitted");
}
if (!collected.includes(FIXTURE_SENTINEL)) {
  throw new Error(
    `expected "${FIXTURE_SENTINEL}" in model output (proves mcpServers reached the SDK); ` +
      `got: ${collected.slice(0, 400)}`,
  );
}
