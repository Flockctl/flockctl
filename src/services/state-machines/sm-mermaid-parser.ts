/**
 * Alternate input format for state machines: a deliberately tiny subset of
 * Mermaid's `stateDiagram-v2` syntax.
 *
 * We do NOT pull in a full Mermaid renderer on the backend — this is a
 * simple line-based parser that accepts only the shapes we actually need:
 *
 *   stateDiagram-v2            (optional header)
 *   [*] --> Idle               initial transition
 *   Idle --> Running : start   event-labelled transition
 *   Running --> [*]            terminal transition (marks state as final)
 *   %% a comment               line-comment
 *
 * The output is the same `StateMachine` shape produced by the YAML parser
 * in `sm-parser.ts`, so both formats flow into the same downstream tooling
 * (validator, diagram renderer, registry).
 */

import type {
  ParseError,
  Result,
  StateMachine,
  Transition,
} from "./sm-parser";

const ARROW = "-->";
const TERMINAL_MARK = "[*]";
const HEADER_RE = /^stateDiagram(-v2)?$/;
const STATE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strip an inline `%% …` comment from a single line. */
function stripComment(line: string): string {
  const idx = line.indexOf("%%");
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Parse a mermaid `stateDiagram-v2` document (subset) into a StateMachine.
 *
 * Semantics:
 *   - `[*] --> X` declares `X` as the initial state. At most one initial
 *     may be declared; repeating with the same target is tolerated.
 *   - `X --> [*]` marks `X` as a final state.
 *   - `A --> B : event` declares a transition. The event label is
 *     mandatory for non-terminal transitions.
 *   - A transition's event must not be empty.
 *   - State order is preserved in the order states are first mentioned.
 */
export function parseMermaidStateDiagram(
  text: string,
): Result<StateMachine, ParseError[]> {
  const errors: ParseError[] = [];
  const lines = text.split(/\r?\n/);

  let initial: string | undefined;
  const finalSet = new Set<string>();
  // Preserve order of `X --> [*]` declarations so the emitted `final`
  // list is deterministic and matches the source document.
  const finalOrder: string[] = [];
  const transitions: Transition[] = [];

  // Preserve order of first appearance for deterministic output.
  const statesOrder: string[] = [];
  const seenStates = new Set<string>();
  const recordState = (s: string): void => {
    if (seenStates.has(s)) return;
    seenStates.add(s);
    statesOrder.push(s);
  };

  let headerConsumed = false;

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    /* v8 ignore next — defensive: `i < lines.length` guarantees lines[i] is defined. */
    const stripped = stripComment(lines[i] ?? "").trim();
    if (stripped === "") continue;

    // Optional `stateDiagram-v2` header. Accepted only as the first
    // meaningful line; ignored elsewhere so a stray duplicate header
    // surfaces as a normal parse error rather than being silently dropped.
    if (!headerConsumed && HEADER_RE.test(stripped)) {
      headerConsumed = true;
      continue;
    }
    headerConsumed = true;

    const arrowIdx = stripped.indexOf(ARROW);
    if (arrowIdx === -1) {
      errors.push({
        message: `expected transition containing '-->': \`${stripped}\``,
        line: ln,
      });
      continue;
    }

    const left = stripped.slice(0, arrowIdx).trim();
    const rest = stripped.slice(arrowIdx + ARROW.length).trim();

    if (left === "") {
      errors.push({ message: "transition source is empty", line: ln });
      continue;
    }
    if (rest === "") {
      errors.push({ message: "transition target is empty", line: ln });
      continue;
    }

    // Split the right-hand side on the first `:` to peel off the event
    // label. Everything after the colon (trimmed) is the event name.
    let right: string;
    let event: string | undefined;
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) {
      right = rest;
    } else {
      right = rest.slice(0, colonIdx).trim();
      event = rest.slice(colonIdx + 1).trim();
      if (event === "") {
        errors.push({
          message: "transition event label after ':' is empty",
          line: ln,
        });
        continue;
      }
    }

    if (right === "") {
      errors.push({ message: "transition target is empty", line: ln });
      continue;
    }

    // [*] --> [*] is meaningless and mermaid itself rejects it.
    if (left === TERMINAL_MARK && right === TERMINAL_MARK) {
      errors.push({
        message: "transition '[*] --> [*]' is not allowed",
        line: ln,
      });
      continue;
    }

    // Initial declaration: [*] --> State
    if (left === TERMINAL_MARK) {
      if (!STATE_NAME_RE.test(right)) {
        errors.push({
          message: `invalid state name \`${right}\``,
          line: ln,
        });
        continue;
      }
      if (event !== undefined) {
        errors.push({
          message: `initial transition '[*] --> ${right}' must not have an event label`,
          line: ln,
        });
        continue;
      }
      if (initial !== undefined && initial !== right) {
        errors.push({
          message: `multiple initial states declared: \`${initial}\` and \`${right}\``,
          line: ln,
        });
        continue;
      }
      initial = right;
      recordState(right);
      continue;
    }

    // Final declaration: State --> [*]
    if (right === TERMINAL_MARK) {
      if (!STATE_NAME_RE.test(left)) {
        errors.push({
          message: `invalid state name \`${left}\``,
          line: ln,
        });
        continue;
      }
      if (event !== undefined) {
        errors.push({
          message: `final transition '${left} --> [*]' must not have an event label`,
          line: ln,
        });
        continue;
      }
      recordState(left);
      if (!finalSet.has(left)) {
        finalSet.add(left);
        finalOrder.push(left);
      }
      continue;
    }

    // Normal transition: A --> B : event
    if (!STATE_NAME_RE.test(left)) {
      errors.push({ message: `invalid state name \`${left}\``, line: ln });
      continue;
    }
    if (!STATE_NAME_RE.test(right)) {
      errors.push({ message: `invalid state name \`${right}\``, line: ln });
      continue;
    }
    if (event === undefined) {
      errors.push({
        message: `transition '${left} --> ${right}' is missing an event label (use ': eventName')`,
        line: ln,
      });
      continue;
    }

    recordState(left);
    recordState(right);
    transitions.push({ from: left, to: right, event });
  }

  if (initial === undefined) {
    errors.push({
      message: "missing initial state declaration: '[*] --> <state>'",
    });
  }
  if (statesOrder.length === 0) {
    errors.push({ message: "no states declared" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sm: StateMachine = {
    states: statesOrder,
    initial: initial as string,
    transitions,
  };
  if (finalOrder.length > 0) {
    sm.final = finalOrder;
  }
  return { ok: true, value: sm };
}
