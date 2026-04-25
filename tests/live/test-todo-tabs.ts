/**
 * End-to-end live test for the per-agent Todo history grouping. Boots a real
 * flockctl daemon against an isolated FLOCKCTL_HOME, drives one chat turn
 * through the streaming endpoint, and verifies that:
 *
 *   1. The main agent's TodoWrite snapshots land in `chat_todos` with a
 *      NULL `parent_tool_use_id`.
 *   2. Each sub-agent the model spawns via the Task tool produces a
 *      separate group in `GET /chats/:id/todos/agents`, keyed by the
 *      spawning Task call's `tool_use_id`.
 *   3. The /agents response carries human labels resolved from the
 *      spawning Task call's `description` (so the drawer's tabs read e.g.
 *      "tester-1" instead of a hash).
 *
 * The prompt is intentionally explicit — the model is asked to:
 *   a) emit a 3-item TodoWrite from the main agent
 *   b) spawn TWO sub-agents via the Task tool with descriptions
 *      "tester-1" and "tester-2"
 *   c) instruct each sub-agent to emit its own TodoWrite snapshot
 *
 * Skipped (exit 77) when the claude CLI is missing — the SDK shells out to
 * it for auth, so without the binary the daemon can't run a real turn.
 *
 * Run locally:
 *
 *   FLOCKCTL_LIVE_TESTS=1 npx tsx tests/live/test-todo-tabs.ts
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

try {
  execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
} catch {
  console.log("  (skipping: claude CLI not installed)");
  process.exit(77);
}

async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close();
        rej(new Error("could not get port"));
      }
    });
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const port = await pickFreePort();
const home = mkdtempSync(join(tmpdir(), "flockctl-live-todo-tabs-"));
let daemon: ChildProcess | null = null;
let stdoutBuf = "";

function spawnDaemon(): ChildProcess {
  const child = spawn(
    "npx",
    ["tsx", join(repoRoot, "src/server-entry.ts"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FLOCKCTL_HOME: home,
        // Intentionally NOT setting FLOCKCTL_MOCK_AI — this is a live test.
      },
      cwd: repoRoot,
    },
  );
  child.stdout?.on("data", (d) => { stdoutBuf += d.toString(); });
  child.stderr?.on("data", (d) => { stdoutBuf += d.toString(); });
  return child;
}

async function waitForReady(baseUrl: string, child: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early (${child.exitCode}):\n${stdoutBuf}`);
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`daemon never responded on /health:\n${stdoutBuf}`);
}

async function killDaemon() {
  if (!daemon) return;
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((res) => setTimeout(res, 300));
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
}

interface AgentItem {
  key: string;
  parentToolUseId: string | null;
  label: string;
  subagentType: string | null;
  snapshotCount: number;
  latest: { id: number; createdAt: string; todos: any[]; counts: any } | null;
}

try {
  daemon = spawnDaemon();
  const baseUrl = `http://localhost:${port}`;
  await waitForReady(baseUrl, daemon);

  // Seed a key — the chat route validates that an active key exists before
  // dispatching. The SDK uses claude-CLI auth (not this `keyValue`), so the
  // value can be a placeholder; the key just has to exist and be active.
  const keyRes = await fetch(`${baseUrl}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      providerType: "api-key",
      label: "live-todo-tabs",
      keyValue: "sk-ant-api-live",
      isActive: true,
    }),
  });
  if (keyRes.status !== 201) {
    throw new Error(`POST /keys failed (${keyRes.status}): ${await keyRes.text()}`);
  }
  const key = (await keyRes.json()) as { id: number };

  // Create the chat — no project / workspace, default permission mode.
  const chatRes = await fetch(`${baseUrl}/chats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "live todo tabs", aiProviderKeyId: key.id }),
  });
  if (chatRes.status !== 201 && chatRes.status !== 200) {
    throw new Error(`POST /chats failed (${chatRes.status}): ${await chatRes.text()}`);
  }
  const chat = (await chatRes.json()) as { id: number };

  // The prompt is the test's contract — every word matters. Asking the
  // agent to use specific Task `description` strings ("tester-1" /
  // "tester-2") lets us assert the per-agent labels match. Asking each
  // sub-agent to call TodoWrite immediately is what makes them appear in
  // chat_todos as their own group.
  const prompt = [
    "I'm running an end-to-end test of your sub-agent and TodoWrite plumbing.",
    "Please do the following EXACTLY:",
    "1. Call the TodoWrite tool with these three todos (status pending):",
    "   - 'main step A'",
    "   - 'main step B'",
    "   - 'main step C'",
    "2. Then call the Task tool TWICE in parallel:",
    "   a. description='tester-1', subagent_type='general-purpose',",
    "      prompt='Call TodoWrite once with two todos: [{content:\"sub1 step 1\",status:\"pending\",activeForm:\"Doing sub1 step 1\"},{content:\"sub1 step 2\",status:\"pending\",activeForm:\"Doing sub1 step 2\"}]. Then reply DONE.'",
    "   b. description='tester-2', subagent_type='general-purpose',",
    "      prompt='Call TodoWrite once with two todos: [{content:\"sub2 step 1\",status:\"pending\",activeForm:\"Doing sub2 step 1\"},{content:\"sub2 step 2\",status:\"pending\",activeForm:\"Doing sub2 step 2\"}]. Then reply DONE.'",
    "3. Finally update the main TodoWrite snapshot to mark step A as completed,",
    "   then reply with the literal word DONE.",
  ].join("\n");

  // Drive the streaming endpoint and wait for it to drain. We don't care
  // about the SSE payload contents — the side effect we test is what
  // landed in chat_todos / chat_messages.
  const streamRes = await fetch(`${baseUrl}/chats/${chat.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: prompt }),
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`POST /messages/stream failed (${streamRes.status}): ${await streamRes.text()}`);
  }
  const reader = streamRes.body.getReader();
  const turnDeadline = Date.now() + 240_000; // 4 min ceiling — sub-agent fan-out is slow
  while (true) {
    if (Date.now() > turnDeadline) {
      await reader.cancel();
      throw new Error("agent turn never completed within 4 minutes");
    }
    const { done } = await reader.read();
    if (done) break;
  }

  // Hit the per-agent endpoint that powers the drawer's tab strip.
  const agentsRes = await fetch(`${baseUrl}/chats/${chat.id}/todos/agents`);
  if (!agentsRes.ok) {
    throw new Error(`GET /todos/agents failed (${agentsRes.status}): ${await agentsRes.text()}`);
  }
  const agentsBody = (await agentsRes.json()) as { items: AgentItem[] };

  // ─── Assertions ─────────────────────────────────────────────
  if (agentsBody.items.length < 3) {
    throw new Error(
      `expected at least 3 agent groups (main + 2 sub-agents), got ${agentsBody.items.length}: ` +
        JSON.stringify(agentsBody.items.map((a) => ({ key: a.key, label: a.label }))),
    );
  }

  const main = agentsBody.items.find((a) => a.key === "main");
  if (!main) throw new Error("expected a 'main' agent group, got none");
  if (main.parentToolUseId !== null) {
    throw new Error(`main agent must have parentToolUseId === null, got ${main.parentToolUseId}`);
  }
  if (main.label !== "Main agent") {
    throw new Error(`main agent label should be 'Main agent', got '${main.label}'`);
  }
  if (!main.latest) throw new Error("main agent must have a latest snapshot");
  if (main.latest.todos.length < 3) {
    throw new Error(
      `main agent latest snapshot should have ≥3 todos, got ${main.latest.todos.length}`,
    );
  }

  const subAgents = agentsBody.items.filter((a) => a.key !== "main");
  if (subAgents.length < 2) {
    throw new Error(`expected ≥2 sub-agents, got ${subAgents.length}`);
  }
  const labels = new Set(subAgents.map((a) => a.label));
  if (!labels.has("tester-1") || !labels.has("tester-2")) {
    throw new Error(
      `sub-agent labels must include 'tester-1' AND 'tester-2', got ${[...labels].join(", ")}`,
    );
  }
  for (const sub of subAgents) {
    if (!sub.parentToolUseId || !sub.parentToolUseId.startsWith("toolu_")) {
      throw new Error(
        `sub-agent ${sub.label} should have a toolu_ parentToolUseId, got ${sub.parentToolUseId}`,
      );
    }
    if (!sub.latest || sub.latest.todos.length === 0) {
      throw new Error(`sub-agent ${sub.label} must have ≥1 todos in its latest snapshot`);
    }
  }

  // Spot-check completedAt: the main agent should have step A marked
  // completed (by step 3 of the prompt), and that completed todo's
  // `completedAt` should be a non-null ISO timestamp.
  const completedTodo = main.latest.todos.find(
    (t: any) => t.status === "completed" && /step a/i.test(String(t.content)),
  );
  if (!completedTodo) {
    throw new Error(
      `main agent latest snapshot should include a completed 'step A', got: ` +
        JSON.stringify(main.latest.todos),
    );
  }
  if (typeof completedTodo.completedAt !== "string" || completedTodo.completedAt.length === 0) {
    throw new Error(
      `completed todo must carry a completedAt timestamp, got ${JSON.stringify(completedTodo)}`,
    );
  }

  console.log(
    `  agents=${agentsBody.items.length} main_todos=${main.latest.todos.length} ` +
      `sub_labels=${[...labels].join(",")}`,
  );
} finally {
  await killDaemon();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}
