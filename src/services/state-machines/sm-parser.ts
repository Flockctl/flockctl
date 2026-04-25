/**
 * State machine shared types + format-agnostic semantic validators.
 *
 * The YAML DSL parser was removed — the only supported authoring format is now
 * Mermaid `stateDiagram-v2` (see `sm-mermaid-parser.ts`). These types are what
 * every parser produces, and the `validate*` functions below operate on the
 * normalized `StateMachine` shape independent of its source syntax.
 */

export interface Transition {
  from: string;
  to: string;
  event: string;
}

export interface StateMachine {
  states: string[];
  initial: string;
  transitions: Transition[];
  final?: string[];
}

export interface ParseError {
  message: string;
  path?: string;
  line?: number;
}

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; errors: E };

/* -------------------------------------------------------------------------- */
/* Semantic validator                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Categories of semantic issue a state machine can exhibit AFTER it has
 * already passed structural parsing. They map 1:1 to the individual rule
 * functions below.
 */
export type ValidationCategory =
  | "initial-not-in-states"
  | "transition-from-not-in-states"
  | "transition-to-not-in-states"
  | "duplicate-transition"
  | "final-has-outgoing"
  | "unreachable-state";

export type Severity = "error" | "warning";

export interface ValidationError {
  category: ValidationCategory;
  severity: Severity;
  message: string;
  path?: string;
}

/** Rule: `initial` must be one of the declared `states`. */
export function validateInitialInStates(
  sm: StateMachine,
): ValidationError[] {
  if (sm.states.includes(sm.initial)) return [];
  return [
    {
      category: "initial-not-in-states",
      severity: "error",
      message: `\`initial\` \`${sm.initial}\` is not in \`states\``,
      path: "initial",
    },
  ];
}

/** Rule: every `transition.from` must reference a declared state. */
export function validateTransitionFromInStates(
  sm: StateMachine,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const known = new Set(sm.states);
  sm.transitions.forEach((t, i) => {
    if (!known.has(t.from)) {
      errors.push({
        category: "transition-from-not-in-states",
        severity: "error",
        message: `transition \`from\` \`${t.from}\` is not in \`states\``,
        path: `transitions[${i}].from`,
      });
    }
  });
  return errors;
}

/** Rule: every `transition.to` must reference a declared state. */
export function validateTransitionToInStates(
  sm: StateMachine,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const known = new Set(sm.states);
  sm.transitions.forEach((t, i) => {
    if (!known.has(t.to)) {
      errors.push({
        category: "transition-to-not-in-states",
        severity: "error",
        message: `transition \`to\` \`${t.to}\` is not in \`states\``,
        path: `transitions[${i}].to`,
      });
    }
  });
  return errors;
}

/**
 * Rule: no two transitions may share the same `(from, event)` pair —
 * otherwise the machine is non-deterministic.
 */
export function validateNoDuplicateTransitions(
  sm: StateMachine,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const firstSeen = new Map<string, number>();
  sm.transitions.forEach((t, i) => {
    const key = `${t.from}\u0000${t.event}`;
    const prev = firstSeen.get(key);
    if (prev === undefined) {
      firstSeen.set(key, i);
      return;
    }
    errors.push({
      category: "duplicate-transition",
      severity: "error",
      message: `duplicate transition for (\`${t.from}\`, \`${t.event}\`); first defined at transitions[${prev}]`,
      path: `transitions[${i}]`,
    });
  });
  return errors;
}

/** Rule: final states must not have any outgoing transitions. */
export function validateFinalStatesHaveNoOutgoing(
  sm: StateMachine,
): ValidationError[] {
  if (!sm.final || sm.final.length === 0) return [];
  const finals = new Set(sm.final);
  const errors: ValidationError[] = [];
  sm.transitions.forEach((t, i) => {
    if (finals.has(t.from)) {
      errors.push({
        category: "final-has-outgoing",
        severity: "error",
        message: `final state \`${t.from}\` must not have outgoing transitions`,
        path: `transitions[${i}]`,
      });
    }
  });
  return errors;
}

/**
 * Rule: every non-initial state should be reachable from `initial` by
 * following `transitions`. Unreachable states are reported as `warning` —
 * the machine is still well-formed, just has dead code.
 *
 * Uses a breadth-first walk starting at `initial`, skipping any transition
 * whose `from` isn't in `states` (those are reported by a separate rule).
 */
export function validateReachability(
  sm: StateMachine,
): ValidationError[] {
  if (!sm.states.includes(sm.initial)) return [];

  // Adjacency: state -> set of directly reachable states
  const adj = new Map<string, Set<string>>();
  for (const s of sm.states) adj.set(s, new Set());
  const known = new Set(sm.states);
  for (const t of sm.transitions) {
    if (!known.has(t.from) || !known.has(t.to)) continue;
    adj.get(t.from)!.add(t.to);
  }

  const reachable = new Set<string>();
  const queue: string[] = [sm.initial];
  reachable.add(sm.initial);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const errors: ValidationError[] = [];
  sm.states.forEach((s, i) => {
    if (!reachable.has(s)) {
      errors.push({
        category: "unreachable-state",
        severity: "warning",
        message: `state \`${s}\` is not reachable from \`initial\` \`${sm.initial}\``,
        path: `states[${i}]`,
      });
    }
  });
  return errors;
}

/**
 * Run every semantic rule against `sm` and return a flat list of findings.
 * Errors come first, then warnings, each rule in the order listed above.
 */
export function validateStateMachine(
  sm: StateMachine,
): ValidationError[] {
  return [
    ...validateInitialInStates(sm),
    ...validateTransitionFromInStates(sm),
    ...validateTransitionToInStates(sm),
    ...validateNoDuplicateTransitions(sm),
    ...validateFinalStatesHaveNoOutgoing(sm),
    ...validateReachability(sm),
  ];
}
