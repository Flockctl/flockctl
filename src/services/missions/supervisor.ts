// ─── Mission supervisor: SupervisorService ───
//
// The single entry-point a caller uses to "look at the mission timeline,
// decide what (if anything) to do next, persist the decision". Composed of
// three building blocks shipped earlier in this slice:
//
//   1. buildSupervisorPrompt()          — composes an injection-resistant
//                                         prompt from the trusted mission
//                                         context plus a fenced DATA block
//                                         of untrusted task output.
//   2. guardedEvaluate()                — sequences BudgetEnforcer.check →
//                                         MaxDepthGuard.check → evaluator() →
//                                         BudgetEnforcer.increment() → INSERT
//                                         mission_events. Every supervisor
//                                         LLM call MUST funnel through this
//                                         composer (parent slice §02 invariant).
//   3. supervisorOutputSchema (zod)     — last line of defence on the model's
//                                         reply. A jailbroken / hallucinating
//                                         supervisor cannot smuggle a
//                                         destructive proposal past the zod
//                                         parse + the destructive-verb
//                                         refinement.
//
// CRITICAL static contract (parent slice §02 success_criteria):
//   This file imports NOTHING from `src/routes/planning.ts` and NOTHING from
//   `src/services/plan-store/{milestones,slices,tasks}.ts`. The supervisor
//   PROPOSES — it never CREATES — entities. Approval / commit happens
//   elsewhere (slice 11/02 "approval queue"). The
//   `supervisor_has_no_import_of_plan_generator_helpers` test enforces this
//   with a static grep; a future refactor that imports any plan-creation
//   helper here will fail CI.
//
// Heartbeat short-circuit:
//   A `heartbeat` trigger is the periodic "mission still alive" ping. It MUST
//   NOT consume budget, hit the LLM, or generate proposals — but it still
//   funnels through guardedEvaluate so the kill-switch + depth gates fire
//   (a paused mission must not record a heartbeat — the timeline reads
//   cleaner if the kill-switch denies first). The evaluator returns a zero-
//   cost result with `eventKind: 'heartbeat'`.
//
// Broadcast contract:
//   On every successfully-recorded event (allowed === true), broadcast a
//   `mission_event` envelope to all WS clients via wsManager. Envelope shape
//   mirrors the existing `task_status` / `chat_status` convention so UI
//   consumers can drop it into the same dispatcher without a new branch in
//   their type guard.

import { getRawDb } from "../../db/index.js";
import { wsManager } from "../ws-manager.js";
import {
  guardedEvaluate,
  type EvaluatorResult,
  type GuardedEvaluateResult,
} from "./guarded-evaluate.js";

// Re-export so consumers (notably the event-subscriber test, which treats
// `supervisor.ts` as the public surface for the supervisor pipeline) can
// import the discriminated result type alongside `SupervisorService`
// without reaching into `guarded-evaluate.ts` directly.
export type { GuardedEvaluateResult } from "./guarded-evaluate.js";
import type { MissionTrigger } from "./max-depth-guard.js";
import { buildSupervisorPrompt } from "./supervisor-prompt.js";
import {
  supervisorOutputSchema,
  type SupervisorOutput,
} from "./proposal-schema.js";

// ─── LLM seam ───
//
// Pulled into an interface so:
//   (a) tests can drive the supervisor end-to-end without a real Anthropic
//       round-trip;
//   (b) we can swap the underlying agent (Claude SDK today, possibly a
//       cheaper supervisor-tier model later) without churning the composer.
//
// Cost is reported by the implementation post-call so BudgetEnforcer.increment
// gets the same delta the provider reported. A fake LLM in tests can return
// {0,0} to keep budget-arithmetic assertions tractable.

/**
 * The per-call cost an LLM implementation reports back to the supervisor.
 * Mirrors `BudgetDelta` shape (non-negative integers, tokens + integer USD
 * cents) — kept structurally identical so callers can pass the result
 * straight into `BudgetEnforcer.increment` without translation.
 */
export interface SupervisorLLMCost {
  tokens: number;
  cents: number;
}

/** Reply from a single LLM round-trip — raw text plus the cost delta. */
export interface SupervisorLLMReply {
  text: string;
  cost: SupervisorLLMCost;
}

/**
 * Pluggable LLM transport. The production wiring forwards `prompt` to the
 * Claude Agent SDK via `src/services/ai/client.ts`; tests inject a mock
 * that returns a canned reply. Implementations MUST return the model's
 * raw text reply verbatim — strict JSON enforcement is the supervisor's
 * job, not the transport's.
 */
export interface SupervisorLLM {
  complete(prompt: string): Promise<SupervisorLLMReply>;
}

// ─── Public broadcast envelope ───

/**
 * Type tag for the WS broadcast emitted on every successful supervisor
 * evaluation. Held as a const so UI tests (and the dispatcher type guards)
 * can pin the literal without re-typing it on either side.
 */
export const SUPERVISOR_BROADCAST_TYPE = "mission_event" as const;

// ─── Implementation ───

interface MissionRow {
  objective: string;
}

/**
 * Read just the trusted fields the prompt needs from the missions row.
 * Throws on a missing mission rather than silently allowing the supervisor
 * to run against a deleted target — mirrors `BudgetEnforcer.readMission`'s
 * policy.
 */
function readMissionObjective(missionId: string): string {
  const sqlite = getRawDb();
  const row = sqlite
    .prepare("SELECT objective FROM missions WHERE id = ?")
    .get(missionId) as MissionRow | undefined;
  if (!row) {
    throw new Error(`SupervisorService: mission not found: ${missionId}`);
  }
  return row.objective;
}

/**
 * Coerce the untrusted `payload.task_output` field into a string. Any
 * non-string value (including missing) collapses to an empty string so the
 * fenced DATA block in the prompt always renders, even on triggers that
 * carry no upstream output (e.g. operator-fired remediation).
 */
function readTaskOutput(trigger: MissionTrigger): string {
  const raw = trigger.payload?.task_output;
  return typeof raw === "string" ? raw : "";
}

/**
 * Public entry point. A class instead of a free function so the LLM seam
 * can be wired once at startup and re-used across many evaluate() calls
 * without threading the dependency through every call site.
 */
export class SupervisorService {
  constructor(private readonly llm: SupervisorLLM) {}

  /**
   * Evaluate one mission trigger end-to-end. Pipeline:
   *
   *   - heartbeat trigger  → record `heartbeat` event (no LLM, no spend).
   *   - everything else    → load mission, build prompt, call LLM through
   *                          guardedEvaluate, parse the reply via
   *                          supervisorOutputSchema, surface as proposal /
   *                          no_action.
   *   - on success         → broadcast a `mission_event` envelope to all
   *                          WS clients via wsManager.
   *
   * Returns the discriminated `GuardedEvaluateResult` so callers can branch
   * on `allowed` and inspect `reason` on denials. Throws only if the LLM
   * itself throws — propagated; no spend, no event, per the guardedEvaluate
   * failure-mode contract.
   */
  async evaluate(
    missionId: string,
    trigger: MissionTrigger,
  ): Promise<GuardedEvaluateResult> {
    const result = await guardedEvaluate(missionId, trigger, async (ctx) => {
      // Heartbeat short-circuit. Still funnels through guardedEvaluate so
      // the kill-switch + depth gates fire upstream, but we never reach
      // the LLM for periodic pings.
      if (ctx.trigger.kind === "heartbeat") {
        const result: EvaluatorResult = {
          cost: { tokens: 0, cents: 0 },
          eventKind: "heartbeat",
          eventPayload: { reason: "periodic heartbeat" },
        };
        return result;
      }

      // Build the prompt. The composer sees ONLY trusted fields plus the
      // ONE untrusted string (task_output) — buildSupervisorPrompt fences
      // the latter with a length-padded backtick run so a payload that
      // opens with ``` cannot escape.
      const objective = readMissionObjective(ctx.missionId);
      const prompt = buildSupervisorPrompt({
        missionId: ctx.missionId,
        missionObjective: objective,
        triggerKind: ctx.trigger.kind,
        taskOutput: readTaskOutput(ctx.trigger),
        depth: ctx.depth,
        remainingBudget: ctx.budget.remaining,
      });

      // LLM round-trip. A throw here propagates and guardedEvaluate
      // records no spend / no event — we never observed a usage row, so
      // there's nothing to charge.
      const reply = await this.llm.complete(prompt);

      // zod gate. A malformed reply (jailbreak, hallucination, schema
      // drift) is downgraded to a `no_action` event rather than
      // corrupting the timeline with garbage — we still record the cost
      // (the call DID happen) and surface the parse error in the event
      // payload for forensics.
      const parsed = parseSupervisorReply(reply.text);
      if (parsed.kind === "parse_error") {
        const result: EvaluatorResult = {
          cost: reply.cost,
          eventKind: "no_action",
          eventPayload: {
            rationale: "supervisor reply failed schema validation",
            parse_error: parsed.message,
            // Cap the raw payload so a hostile LLM can't grow the
            // mission_events row to gigabytes by replying with junk.
            raw_reply: reply.text.slice(0, 2000),
          },
        };
        return result;
      }

      // Successful parse → route to proposal or no_action.
      if (parsed.output.kind === "proposal") {
        const result: EvaluatorResult = {
          proposal: {
            target_type: parsed.output.target_type,
            candidate: parsed.output.candidate,
          },
          cost: reply.cost,
          eventKind: "remediation_proposed",
          eventPayload: { rationale: parsed.output.rationale },
        };
        return result;
      }
      const result: EvaluatorResult = {
        cost: reply.cost,
        eventKind: "no_action",
        eventPayload: { rationale: parsed.output.rationale },
      };
      return result;
    });

    // Broadcast on the success branch only. The denial branches don't
    // ALWAYS produce a fresh event row (paused / budget-exhausted denials
    // are caller-visible only via the return value; depth_exceeded does
    // write a row, but BudgetEnforcer's own `budget_exceeded` broadcast
    // is owned by that module — emitting a second envelope here would
    // double-fire).
    if (result.allowed) {
      wsManager.broadcastAll({
        type: SUPERVISOR_BROADCAST_TYPE,
        missionId,
        kind: result.eventKind,
        eventId: result.eventId,
        depth: result.depth,
      });
    }

    return result;
  }
}

// ─── Internals ───

type ParseResult =
  | { kind: "ok"; output: SupervisorOutput }
  | { kind: "parse_error"; message: string };

/**
 * Strict JSON + zod gate on the model's raw reply. Two failure modes are
 * normalised into `parse_error` so the caller has a single branch to handle:
 *
 *   - non-JSON text (model emitted prose, code fences, leading whitespace
 *     beyond a JSON value, etc.)
 *   - JSON that doesn't satisfy `supervisorOutputSchema` (wrong discriminator,
 *     destructive verb in candidate.action, missing required field, …)
 */
function parseSupervisorReply(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      kind: "parse_error",
      message: `JSON parse failed: ${(err as Error).message}`,
    };
  }
  const result = supervisorOutputSchema.safeParse(json);
  if (!result.success) {
    return {
      kind: "parse_error",
      message: result.error.issues.map((i) => i.message).join("; "),
    };
  }
  return { kind: "ok", output: result.data };
}
