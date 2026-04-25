/**
 * GitHub Copilot SDK — spike / PoC.
 *
 * Goals (each one a concrete unknown we want to resolve BEFORE we touch
 * `src/services/agents/` in earnest):
 *
 *   [auth]     Does auth work via `gh auth login` or $GH_TOKEN in this env?
 *   [boot]     How long does `CopilotClient` take to spin up the local
 *              JSON-RPC server?
 *   [latency]  Time-to-first-token and total wall-clock for a trivial prompt.
 *   [events]   What are the actual event names emitted by SDK 0.2.x?
 *              (Docs/blog and implementation have diverged before.)
 *   [billing]  Two messages in ONE session — does the second message cost
 *              another premium request, or does the SDK coalesce them like
 *              the remote Coding Agent does? We observe this directly via
 *              the `assistant.usage.quotaSnapshots.usedRequests` counter.
 *
 * This script is intentionally NOT wired into the Flockctl runtime. It lives
 * under `scripts/` (outside `rootDir: ./src`) so it never ships in `dist/`
 * and does not affect `npm run typecheck`.
 *
 * Prerequisites:
 *   1. `npm i -D @github/copilot-sdk`
 *   2. `gh auth login` with a Copilot-enabled account, OR `export GH_TOKEN=...`
 *
 * Run:
 *   npx tsx scripts/copilot-spike.ts
 *   COPILOT_MODEL=gpt-4.1 npx tsx scripts/copilot-spike.ts
 */

import { performance } from "node:perf_hooks";
import process from "node:process";

type CopilotSdk = typeof import("@github/copilot-sdk");

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? "gpt-4.1";
const HARD_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS ?? 60_000);

// Two distinct prompts so we can measure per-message billing deltas.
const PROMPT_A =
  "Respond with EXACTLY one short sentence confirming you are GitHub Copilot. Do not call any tools.";
const PROMPT_B =
  "Now respond with EXACTLY the word 'pong' and nothing else. Do not call any tools.";

interface QuotaSnapshot {
  entitlementRequests?: number;
  usedRequests?: number;
  overage?: number;
  isUnlimitedEntitlement?: boolean;
}

interface TurnMetrics {
  prompt: string;
  firstDeltaMs: number | null;
  totalMs: number;
  deltaCount: number;
  assistantChars: number;
  usageCost: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  usageTtftMs: number | null;
  quotaBefore: QuotaSnapshot | null;
  quotaAfter: QuotaSnapshot | null;
  deltaUsedRequests: number | null;
}

interface Metrics {
  model: string;
  sdkLoadMs: number;
  clientStartMs: number;
  sessionCreateMs: number;
  eventTypesSeen: Record<string, number>;
  permissionRequestsSeen: string[];
  toolCallsSeen: string[];
  turns: TurnMetrics[];
  billingConclusion: string;
}

async function loadSdk(): Promise<CopilotSdk> {
  try {
    return (await import("@github/copilot-sdk")) as CopilotSdk;
  } catch (err) {
    console.error(
      "\n[spike] Could not import @github/copilot-sdk.\n" +
        "        Install first:  npm i -D @github/copilot-sdk\n",
    );
    throw err;
  }
}

function assertAuth(): void {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.warn(
      "[spike] No GH_TOKEN / GITHUB_TOKEN — falling back to `gh auth login`.\n",
    );
  }
}

/**
 * Extract a copilot-premium-requests snapshot out of an assistant.usage event.
 * Field name in SDK 0.2.2 is `quotaSnapshots[*]`, but the specific quota key
 * for premium requests may vary, so we pick whichever snapshot has the
 * highest `usedRequests` (= the one we care about).
 */
function pickPremiumQuota(
  snapshots: Record<string, QuotaSnapshot> | undefined,
): QuotaSnapshot | null {
  if (!snapshots) return null;
  let best: QuotaSnapshot | null = null;
  for (const snap of Object.values(snapshots)) {
    if (!best || (snap.usedRequests ?? 0) > (best.usedRequests ?? 0)) {
      best = snap;
    }
  }
  return best;
}

async function runTurn(
  session: { on: Function; sendAndWait: Function },
  prompt: string,
  metrics: Metrics,
  priorQuota: QuotaSnapshot | null,
): Promise<TurnMetrics> {
  const turn: TurnMetrics = {
    prompt,
    firstDeltaMs: null,
    totalMs: 0,
    deltaCount: 0,
    assistantChars: 0,
    usageCost: null,
    usageInputTokens: null,
    usageOutputTokens: null,
    usageTtftMs: null,
    quotaBefore: priorQuota,
    quotaAfter: null,
    deltaUsedRequests: null,
  };

  const tStart = performance.now();

  // Per-turn listeners — we attach and detach so the next turn's counters
  // start clean. (Session.on returns an unsubscribe fn per the SDK docs.)
  const unsubAll: Array<() => void> = [];

  unsubAll.push(
    session.on("assistant.message_delta", (event: { data?: { deltaContent?: string } }) => {
      if (turn.firstDeltaMs === null) {
        turn.firstDeltaMs = performance.now() - tStart;
      }
      turn.deltaCount += 1;
      const chunk = event?.data?.deltaContent ?? "";
      turn.assistantChars += chunk.length;
      process.stdout.write(chunk);
    }),
  );

  // SDK 0.2.2 does not stream by default — we also capture the final
  // non-streaming assistant.message so the turn output is visible.
  unsubAll.push(
    session.on(
      "assistant.message",
      (event: { data?: { content?: unknown } }) => {
        const content = event?.data?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((c: { text?: string; type?: string }) =>
                    typeof c?.text === "string" ? c.text : "",
                  )
                  .join("")
              : "";
        if (text) {
          turn.assistantChars += text.length;
          process.stdout.write(text);
        }
      },
    ),
  );

  unsubAll.push(
    session.on(
      "assistant.usage",
      (event: {
        data?: {
          cost?: number;
          inputTokens?: number;
          outputTokens?: number;
          ttftMs?: number;
          quotaSnapshots?: Record<string, QuotaSnapshot>;
        };
      }) => {
        const d = event?.data ?? {};
        if (d.cost !== undefined) turn.usageCost = d.cost;
        if (d.inputTokens !== undefined) turn.usageInputTokens = d.inputTokens;
        if (d.outputTokens !== undefined) turn.usageOutputTokens = d.outputTokens;
        if (d.ttftMs !== undefined) turn.usageTtftMs = d.ttftMs;
        const q = pickPremiumQuota(d.quotaSnapshots);
        if (q) turn.quotaAfter = q;
      },
    ),
  );

  // Generic catch-all: record every event type so we document what the SDK
  // actually emits. Relies on `.on(handler)` (no eventType) form per docs.
  unsubAll.push(
    session.on((event: { type?: string; data?: { toolName?: string } }) => {
      const type = event?.type ?? "<untyped>";
      metrics.eventTypesSeen[type] = (metrics.eventTypesSeen[type] ?? 0) + 1;
      if (type === "tool.execution_start") {
        metrics.toolCallsSeen.push(event?.data?.toolName ?? "<unknown>");
      }
    }),
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Hard timeout after ${HARD_TIMEOUT_MS}ms`)),
      HARD_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([session.sendAndWait({ prompt }), timeoutPromise]);
  } finally {
    turn.totalMs = performance.now() - tStart;
    process.stdout.write("\n");
    for (const unsub of unsubAll) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
  }

  if (
    turn.quotaBefore?.usedRequests !== undefined &&
    turn.quotaAfter?.usedRequests !== undefined
  ) {
    turn.deltaUsedRequests =
      turn.quotaAfter.usedRequests - turn.quotaBefore.usedRequests;
  }

  return turn;
}

async function main(): Promise<void> {
  assertAuth();

  const metrics: Metrics = {
    model: DEFAULT_MODEL,
    sdkLoadMs: 0,
    clientStartMs: 0,
    sessionCreateMs: 0,
    eventTypesSeen: {},
    permissionRequestsSeen: [],
    toolCallsSeen: [],
    turns: [],
    billingConclusion: "",
  };

  const tLoadStart = performance.now();
  const { CopilotClient } = await loadSdk();
  metrics.sdkLoadMs = performance.now() - tLoadStart;

  console.log(`[spike] Starting CopilotClient (model=${DEFAULT_MODEL})…`);
  const tClientStart = performance.now();
  const client = new CopilotClient({
    githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    // SDK 0.2.2 accepts: none | error | warning | info | debug | all | default.
    logLevel: process.env.COPILOT_LOG_LEVEL ?? "warning",
  });
  metrics.clientStartMs = performance.now() - tClientStart;

  const tSessionStart = performance.now();
  const session = await client.createSession({
    model: DEFAULT_MODEL,
    onPermissionRequest: (request: { kind: string; toolName?: string }) => {
      metrics.permissionRequestsSeen.push(
        `${request.kind}${request.toolName ? `:${request.toolName}` : ""}`,
      );
      if (request.kind === "read") {
        return { kind: "approved" } as const;
      }
      return { kind: "denied-by-rules" } as const;
    },
  });
  metrics.sessionCreateMs = performance.now() - tSessionStart;

  // ---- Turn A ---------------------------------------------------------------
  console.log("\n[spike] ----- turn A -----");
  const turnA = await runTurn(session, PROMPT_A, metrics, null);
  metrics.turns.push(turnA);

  // ---- Turn B (same session) -----------------------------------------------
  console.log("\n[spike] ----- turn B (same session) -----");
  const turnB = await runTurn(session, PROMPT_B, metrics, turnA.quotaAfter);
  metrics.turns.push(turnB);

  // ---- Teardown -------------------------------------------------------------
  try {
    await session.disconnect?.();
  } catch {
    /* ignore */
  }
  try {
    await client.stop?.();
  } catch {
    /* ignore */
  }

  // ---- Billing conclusion ---------------------------------------------------
  // `usageCost` in the assistant.usage event is the authoritative per-turn
  // billing signal. `quotaSnapshots.usedRequests` is a lagging aggregate and
  // often reads the SAME value on back-to-back turns even when cost>0 was
  // charged — GitHub updates the snapshot asynchronously.
  const costA = turnA.usageCost ?? 0;
  const costB = turnB.usageCost ?? 0;

  if (costA === 0 && costB === 0) {
    metrics.billingConclusion =
      "FREE-TIER-MODEL — both turns reported cost=0 (model is unlimited on " +
      "this plan). To measure premium-request billing, rerun with " +
      "COPILOT_MODEL=<premium-model> e.g. claude-sonnet-4.5.";
  } else if (costA > 0 && costB > 0) {
    metrics.billingConclusion =
      `PER-MESSAGE — turnA cost=${costA}, turnB cost=${costB}. ` +
      "Each prompt in a single session costs a premium request (no " +
      "coalescing like the remote Coding Agent). Design implication: " +
      "pack multi-milestone work into ONE prompt, not N follow-ups.";
  } else if (costA > 0 && costB === 0) {
    metrics.billingConclusion =
      "PER-SESSION — only the first prompt cost a request; follow-ups " +
      "within the same session were free. Design implication: reuse " +
      "sessions aggressively, chain milestones as multi-turn conversation.";
  } else {
    metrics.billingConclusion =
      `UNUSUAL — turnA cost=${costA}, turnB cost=${costB}. ` +
      "Manual investigation needed.";
  }

  console.log("\n[spike] ----- metrics -----");
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((err) => {
  console.error("[spike] fatal:", err);
  process.exit(1);
});
