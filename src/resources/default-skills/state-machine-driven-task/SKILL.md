---
name: state-machine-driven-task
when_to_use:
  - state_machine
  - "regex:/\\bstate\\s+machine\\b/i"
priority: 70
---

# State-Machine-Driven Task

Implement behavior for an entity whose legal transitions are declared in the
project-level state-machine registry at `.flockctl/state-machines/*.md` (one
markdown file per entity, body is a Mermaid `stateDiagram-v2` block). The
registry is the contract — every transition the code introduces must be
declared there.

## When this skill fires

Use this workflow when any of the following holds:

- The task description or prompt references a "state machine" (case-insensitive).
- The entity being modified has a corresponding file under
  `.flockctl/state-machines/` — you can see it by running
  `flockctl state-machines check --diff HEAD` or by grepping the directory.

If neither holds, fall back to the regular `implementation` workflow.

## Core principle: registry is authoritative

- Transitions are declared once, in the per-entity `.md` file under
  `.flockctl/state-machines/`.
- Implementation and tests must both reflect the declared transitions.
- The `flockctl state-machines check` CLI parses the current git diff and
  fails (exit 1) if any new transition is introduced in code without being
  declared in the registry. Run it before committing.

## Workflow

### Step 1 — Read the registry entry

Find the entity's file under `.flockctl/state-machines/<entity>.md`. Note
every declared transition `(from, event, to)` and the `invariants:` list in
the YAML frontmatter, if any. If the entity has no file yet, create one —
the schema is a YAML frontmatter block (`entity`, `filePatterns`, optional
`invariants`) followed by exactly one ```mermaid fenced `stateDiagram-v2`
block.

### Step 2 — Update the registry first if the spec is changing

If the task requires a new transition, add it to the Mermaid diagram *before*
writing code. A reviewer should be able to read the registry diff and
understand the behavior change without reading the implementation.

### Step 3 — Implement, keeping code in sync with the registry

Write the minimum code needed to support each declared transition. Follow
the usual `implementation` skill rules for matching codebase patterns and
reusing utilities.

### Step 4 — Hand-write tests for each declared transition

For every transition listed in the registry for this entity, add at least
one Vitest case that exercises it (happy-path transition, and a negative
test that the event is rejected from disallowed source states where that
matters). The registry is the checklist — walk down the transition list and
confirm each one has a test before marking the task done.

### Step 5 — Gate the change with `flockctl state-machines check`

Before committing:

```bash
flockctl state-machines check --diff HEAD
```

Exit 0 means every transition the diff introduces is declared. Exit 1 prints
`file:line  new transition X→Y not declared in registry` along with a
suggested Mermaid edit. Either update the registry, annotate the false
positive with a trailing `// flockctl-sm-ignore` comment, or rework the code
until the gate passes.

Also run `npm run test:coverage` as usual — the transition tests are part
of the normal Vitest suite.

## Rules

- **Registry first.** If a transition isn't in the entity's Mermaid diagram,
  it doesn't exist. Add it there before writing code that implements it.
- **Every declared transition tested.** A transition without at least one
  corresponding test is a spec violation, not a minor oversight.
- **Pre-commit gate is non-optional.** `flockctl state-machines check` must
  pass on the final diff. Don't disable it with blanket ignores.
- **No YAML DSL.** The old YAML state-machine DSL was removed — Mermaid
  `stateDiagram-v2` inside the registry markdown is the only supported
  authoring format.
