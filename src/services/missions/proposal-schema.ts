// ─── Mission supervisor: proposal output zod schema ───
//
// The single enforcement point for "what may the supervisor LLM emit?"
// Parent slice.md §02 threat_surface mandates a structured-output layer
// between the model and the DB: prompt-injection via quoted task errors
// is the most plausible attack vector against the supervisor, and the
// zod parse is what stops a poisoned model reply from materializing as
// a destructive plan-store mutation.
//
// Two discriminated variants — `proposal` (a candidate next move) and
// `no_action` (the LLM looked and chose to do nothing). Both carry a
// rationale so the timeline (`mission_events.payload.rationale`) is
// always populated; downstream UIs depend on it for the "why?" column.
//
// Destructive-verb refinement on `candidate.action`:
//   The supervisor invariant (parent slice.md success_criteria) is that
//   it writes proposals, never entities — but a proposal still ends up
//   as text the operator may approve verbatim. We pre-filter obviously
//   destructive verbs (`delete`, `drop`, `remove`, `destroy`, `truncate`,
//   `rm `) so a jailbroken model cannot smuggle "delete milestone X"
//   into the approval queue. Case-insensitive, word-boundary matched.
//
// Style note: mirrors the zod-only-no-JSON-schema-twin pattern used in
// `src/services/agent-tools.ts` (askUserQuestionInputSchema). The
// supervisor doesn't need a parallel Anthropic tool-API schema — it
// constrains the model via prompt + post-parse, not via tool grammars.

import { z } from "zod";

// ─── Destructive-verb gate ───

/**
 * Regex matching any token the supervisor must never propose. Word
 * boundaries on the verbs prevent false positives ("predeleted" is fine,
 * "delete" is not). The `rm ` arm intentionally requires a trailing
 * space so legitimate prose ("perform task") doesn't trigger it; the
 * shell-style `rm <path>` form does.
 *
 * Exported so tests can pin the exact pattern instead of guessing the
 * refinement's behavior from the outside.
 */
export const DESTRUCTIVE_VERB_RE =
  /\b(?:delete|drop|remove|destroy|truncate)\b|\brm\s/i;

/**
 * `false` ⇒ zod refinement fails ⇒ schema rejects.
 * Pulled out so `proposalSchema` reads like English at the call site.
 */
function notDestructiveVerb(action: string): boolean {
  return !DESTRUCTIVE_VERB_RE.test(action);
}

// ─── Candidate shape ───
//
// Open-ended on purpose. The supervisor proposes "what to do next" in
// natural-ish form; the auto-executor / plan-store layer is what turns
// an approved proposal into concrete writes. We constrain only what
// matters for safety + display:
//   - `action`        the verb-phrase shown to the operator
//   - `target_id`     optional pointer back into the plan store
//   - `summary`       optional human-readable elaboration
//   - …passthrough    additional structured hints (left untyped so the
//                     prompt can evolve without a schema migration)
const candidateSchema = z
  .object({
    action: z
      .string()
      .min(1, "candidate.action must be non-empty")
      .max(500, "candidate.action is capped at 500 chars")
      .refine(notDestructiveVerb, {
        message:
          "candidate.action contains a destructive verb (delete/drop/remove/destroy/truncate/rm) — supervisor proposals must not encode destruction",
      }),
    target_id: z.string().min(1).max(200).optional(),
    summary: z.string().max(2000).optional(),
  })
  .passthrough();

// ─── Public schemas ───

/**
 * The "supervisor proposes a next move" variant. `target_type` is an
 * enum-bounded discriminator that mirrors the plan-store hierarchy —
 * any other value (e.g. `'database'`, `'workspace'`) is out of scope
 * for the supervisor and zod will reject it before it reaches the DB.
 */
export const proposalSchema = z.object({
  kind: z.literal("proposal"),
  rationale: z
    .string()
    .min(10, "rationale must be ≥ 10 chars (operator-facing 'why?')")
    .max(4000),
  target_type: z.enum(["milestone", "slice", "task"]),
  candidate: candidateSchema,
});

/**
 * The "supervisor looked and decided to do nothing" variant. Still
 * requires a non-empty rationale — silent no-action is unhelpful to the
 * operator scrolling the mission timeline.
 */
export const noActionSchema = z.object({
  kind: z.literal("no_action"),
  rationale: z
    .string()
    .min(10, "rationale must be ≥ 10 chars (operator-facing 'why?')")
    .max(4000),
});

/**
 * Discriminated union covering everything the supervisor is allowed to
 * emit. Use this at the parse boundary; `.parse()` will route to the
 * correct branch based on `kind` and surface a single error per call.
 */
export const supervisorOutputSchema = z.discriminatedUnion("kind", [
  proposalSchema,
  noActionSchema,
]);

export type Proposal = z.infer<typeof proposalSchema>;
export type NoAction = z.infer<typeof noActionSchema>;
export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;
