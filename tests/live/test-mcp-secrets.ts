/**
 * Live regression test for the MCP-secrets path.
 *
 * Background — there are TWO places where a `${secret:NAME}` reference inside
 * an MCP server's `env` must be substituted before the spawned MCP child
 * process boots:
 *   1. Reconcile time, when flockctl writes `.mcp.json` to disk for the
 *      interactive `claude` CLI (covered by claude-sync-full.test.ts).
 *   2. Session time, when flockctl hands the Claude Agent SDK an explicit
 *      `mcpServers` argument — because that argument OVERRIDES `.mcp.json`.
 *      Skip the substitution here and the MCP server gets the literal
 *      string "${secret:GITHUB_TOKEN}" in its env, silently breaking auth
 *      with no test coverage to catch it.
 *
 * This live test pins #2 end-to-end, with a real model in the loop:
 *   1. Bootstraps an isolated FLOCKCTL_HOME with real DB migrations.
 *   2. Inserts workspace + project + secret via the production helpers
 *      (`upsertSecret` exercises the encryption-at-rest path).
 *   3. Writes a project-scoped MCP config with `env: { LIVE_SECRET_PROBE:
 *      "${secret:LIVE_SECRET_PROBE}" }`.
 *   4. Calls `resolveMcpServersForSession(projectId, …)` — the SAME function
 *      `AgentSession` calls before forwarding to the SDK.
 *   5. Hands the result to `streamViaClaudeAgentSDK` (production path).
 *   6. Asks Haiku to call the fixture's `flockctl_live_echo_env` tool, which
 *      returns whatever value its OWN process env received.
 *   7. Asserts the response contains "OK:<secret value>" — proving the
 *      decrypted secret survived every hop.
 *
 * Failure modes this test catches that nothing else does:
 *   - resolveMcpServersForSession forgets to call resolveServerSecrets
 *     → fixture sees the placeholder, returns "PLACEHOLDER", test fails.
 *   - SDK silently strips `env` from mcpServers → fixture sees MISSING.
 *   - Encryption layer is broken → upsertSecret throws.
 *
 * Skipped (exit 77) when the Claude CLI is not installed or not authenticated.
 * Run locally with:
 *
 *   FLOCKCTL_LIVE_TESTS=1 npx tsx tests/live/test-mcp-secrets.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
} catch {
  console.log("  (skipping: claude CLI not installed)");
  process.exit(77);
}

// Bootstrap an isolated FLOCKCTL_HOME *before* importing any flockctl
// internals — many of them resolve paths via `getFlockctlHome()` at import
// time (or close to it) and we need that to point at our temp dir, not the
// developer's real ~/.flockctl.
const tmpHome = mkdtempSync(join(tmpdir(), "flockctl-live-mcp-secrets-"));
process.env.FLOCKCTL_HOME = tmpHome;

const { runMigrations } = await import("../../src/db/migrate.js");
const { getDb, getRawDb } = await import("../../src/db/index.js");
const { workspaces, projects } = await import("../../src/db/schema.js");
const { upsertSecret } = await import("../../src/services/secrets.js");
const { resolveMcpServersForSession } = await import(
  "../../src/services/agent-session/session-mcp.js"
);
const { streamViaClaudeAgentSDK } = await import("../../src/services/claude/cli.js");
const {
  SECRET_PROBE_ENV_VAR,
  SECRET_PROBE_TOOL_NAME,
  SECRET_PROBE_PREFIX_OK,
  SECRET_PROBE_MISSING,
  SECRET_PROBE_PLACEHOLDER,
} = await import("./mcp-secret-fixture.js");

const SECRET_VALUE = "live-secret-" + Math.random().toString(36).slice(2, 10);
const MCP_SERVER_NAME = "flockctl-live-secret-probe";
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "mcp-secret-fixture.ts");
const tsxBin = (() => {
  try {
    return execFileSync(
      "node",
      ["-e", "process.stdout.write(require.resolve('tsx/cli'))"],
      { cwd: join(here, "..", ".."), encoding: "utf8" },
    ).trim();
  } catch {
    return "tsx";
  }
})();

let cleanupNeeded = true;
function cleanup() {
  if (!cleanupNeeded) return;
  cleanupNeeded = false;
  try {
    getRawDb().close();
  } catch {
    // best-effort
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  // ─── 1-2. DB + migrations + workspace/project/secret ────────────────────
  runMigrations();
  const db = getDb();

  const wsPath = mkdtempSync(join(tmpHome, "ws-"));
  const ws = db
    .insert(workspaces)
    .values({ name: "live-mcp-secrets-ws", path: wsPath })
    .returning()
    .get();
  if (!ws) throw new Error("failed to seed workspace");

  const projPath = mkdtempSync(join(tmpHome, "proj-"));
  const proj = db
    .insert(projects)
    .values({ name: "live-mcp-secrets-proj", workspaceId: ws.id, path: projPath })
    .returning()
    .get();
  if (!proj) throw new Error("failed to seed project");

  upsertSecret({
    scope: "project",
    scopeId: proj.id,
    name: SECRET_PROBE_ENV_VAR,
    value: SECRET_VALUE,
  });

  // ─── 3. Project-scoped MCP config that references the secret ─────────────
  mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
  writeFileSync(
    join(projPath, ".flockctl", "mcp", `${MCP_SERVER_NAME}.json`),
    JSON.stringify({
      command: "node",
      args: [tsxBin, fixturePath],
      env: {
        [SECRET_PROBE_ENV_VAR]: `\${secret:${SECRET_PROBE_ENV_VAR}}`,
      },
    }),
  );

  // ─── 4. Resolve as the production code does ──────────────────────────────
  const mcpServers = resolveMcpServersForSession(proj.id, "live-test");
  if (!mcpServers) {
    throw new Error("resolveMcpServersForSession returned undefined — expected our server");
  }
  const cfg = mcpServers[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  if (!cfg) {
    throw new Error(`server "${MCP_SERVER_NAME}" not in resolved set`);
  }
  // First-line defense (asserted before invoking the model so a regression
  // here surfaces as a fast, deterministic failure rather than a 30-second
  // model round-trip): the env value must already be substituted.
  const envObj = (cfg as { env?: Record<string, string> }).env ?? {};
  if (envObj[SECRET_PROBE_ENV_VAR] !== SECRET_VALUE) {
    throw new Error(
      `pre-SDK env mismatch — expected ${SECRET_VALUE!}, got ${JSON.stringify(envObj[SECRET_PROBE_ENV_VAR])}`,
    );
  }

  // ─── 5-6. Real model round-trip through the SDK ──────────────────────────
  const iter = streamViaClaudeAgentSDK({
    model: "claude-haiku-4-5-20251001",
    system:
      `You are a test harness. Call the tool mcp__${MCP_SERVER_NAME}__${SECRET_PROBE_TOOL_NAME} ` +
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
    mcpServers,
  });

  let collected = "";
  let sawDone = false;
  for await (const ev of iter) {
    if (ev.type === "text" && ev.text) collected += ev.text;
    if (ev.type === "done") sawDone = true;
  }
  if (!sawDone) throw new Error("stream ended without a `done` event");

  // ─── 7. Assertions ───────────────────────────────────────────────────────
  if (collected.includes(SECRET_PROBE_MISSING)) {
    throw new Error(
      `MCP fixture reported MISSING — env was not forwarded to the child process. ` +
        `Output: ${collected.slice(0, 400)}`,
    );
  }
  if (collected.includes(SECRET_PROBE_PLACEHOLDER)) {
    throw new Error(
      `MCP fixture reported PLACEHOLDER — env arrived as a literal "\${secret:...}" string ` +
        `instead of the resolved secret value. This is the regression this test guards. ` +
        `Output: ${collected.slice(0, 400)}`,
    );
  }
  const expected = `${SECRET_PROBE_PREFIX_OK}${SECRET_VALUE}`;
  if (!collected.includes(expected)) {
    throw new Error(
      `expected "${expected}" in model output (proves the secret reached the MCP child process); ` +
        `got: ${collected.slice(0, 400)}`,
    );
  }

  console.log(`  ok — secret survived: flockctl DB → resolveMcpServersForSession → SDK → MCP env`);
} finally {
  cleanup();
}
