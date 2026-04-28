# Missions

Missions are Flockctl's *supervised* layer: a long-running goal that watches what happens in a project and proposes the next move whenever something changes. Where a slice or task captures "one PR's worth of work", a mission captures "keep an eye on this objective and tell me what to do next". This document is the operator-facing reference — for where the components live in the codebase see [ARCHITECTURE.md §Missions subsystem](ARCHITECTURE.md#missions-subsystem); for the supervisor's contract from the agent's point of view see [AGENTS.md §Supervisor sessions](../AGENTS.md#supervisor-sessions).

## What is a mission

A mission is **one project-scoped goal** with a budget and an autonomy mode attached. It runs forever (or until you pause / complete / abort it) and reacts to events:

- A task running in the project finishes, fails, or stalls.
- A heartbeat ticks (every 15 minutes for active missions).
- A previous supervisor proposal is approved and triggers downstream work.

When any of these fires, the **supervisor** — a read-only Flockctl agent session — wakes up, looks at the trigger, and emits a single JSON reply: either a `propose` with a concrete next move, or a `no_action` with a reason. The mission timeline (`mission_events`) records every wake-up, proposal, approval, dismissal, budget reject, and parse failure as an append-only audit log.

Missions sit **alongside** the planning hierarchy, not inside it:

```
Project
├── Milestone → Slice → Plan-task        ← planning
├── Task / Chat                          ← execution
└── Mission                              ← supervised goal
       └── mission_events (append-only timeline)
```

A mission does not own slices or tasks — it *proposes* them. An approved proposal materialises as a milestone, slice, or plan-task in the existing plan store, and from there it executes through the same auto-executor any other plan entity would. The mission's only persistent state is its objective, its budget burn-down, its autonomy mode, and its timeline.

| Field | Purpose |
|-------|---------|
| `objective` | One sentence — what success looks like. Free text, capped at 8000 chars. |
| `autonomy` | `manual` / `suggest` / `auto` (see below). |
| `status` | `drafting` / `active` / `paused` / `completed` / `failed` / `aborted`. Only `active` missions evaluate triggers. |
| `budget_tokens` / `budget_usd_cents` | Hard ceilings for cumulative supervisor spend. |
| `spent_tokens` / `spent_usd_cents` | Running totals, incremented atomically by `BudgetEnforcer`. |
| `supervisor_prompt_version` | Pinned `SUPERVISOR_PROMPT_VERSION` at creation time (see *Supervisor prompt versioning*). |

**Where missions show up in the UI:**

- The project tree gains a **Missions** node listing every mission attached to the project.
- Each mission has a detail page showing objective, budget burn-down, the supervisor log, and pending proposals.
- The global **Inbox** surfaces pending mission proposals alongside task approvals and permission requests.

## Autonomy levels

Autonomy is the policy that decides what happens to a supervisor proposal once the JSON reply lands.

| Mode | Behaviour | Default? |
|------|-----------|----------|
| `manual` | Supervisor still wakes up and writes proposals to the timeline, but the UI surfaces them as informational only — no approval queue entry. Useful when you want the timeline as a passive observer without ever acting on it. | No |
| `suggest` | Every `propose` lands in the **approval queue**. Nothing mutates the plan store until you approve. Rejecting a proposal is a first-class outcome — recorded as a `remediation_dismissed` event and safe to retry. | **Yes** |
| `auto` | Apply proposals without per-step approval, capped only by the budget and depth guards. | No |

**Why `auto` is deliberately blocked in v1.** The schema accepts `auto` (`autonomy IN ('manual','suggest','auto')` is the DB CHECK constraint), but `POST /missions` and `PATCH /missions/:id` return **`501 Not Implemented`** when `autonomy === 'auto'`, and the UI's "auto" button is disabled in parallel. The reason is structural, not cosmetic:

- The supervisor itself is, by design, a read-only proposer — it has no plan-mutation tools and its output schema rejects destructive verbs at parse time. To run "auto", a separate execution path would have to take a stored proposal and apply it without further validation. That path exists today only for the operator-driven approval handler (`POST /missions/:id/proposals/:pid/approve`), which re-runs the same zod the supervisor ran when it minted the proposal — closing the gap where a forged `mission_events` row could cash a malformed payload in for a real mutation.
- Until the apply path has its own threat-modelled auth boundary, "approve = human attention" is the only check between a poisoned model reply and your repo. Removing it before that work is done is exactly the loaded-footgun we built the queue to prevent.
- The autonomy column is wired through the schema, the API, and the UI so the feature can land later as a daemon-config flip plus a bounded executor — without a migration.

The TL;DR: pick `suggest` and approve from the queue. Use `manual` if you want the timeline without the approval workflow. `auto` is not a shortcut you're missing — it's a feature we have not finished securing.

## Guardrails

Three independent gates run on every supervisor wake-up. Any one of them returning "halt" downgrades the trigger to a recorded `no_action` (or `budget_exceeded` / `depth_exceeded`) event with no LLM round-trip — so a misbehaving mission cannot run away with your tokens, your budget, or your stack.

| Guard | Limit | Action on breach |
|-------|-------|-------------------|
| **Token budget** | `budget_tokens` (per mission, integer ≤ INT32_MAX, > 0) | Mission flips to `status='paused'`, `budget_exceeded` event written atomically, supervisor refuses further evaluations until the cap is raised or the mission is unpaused. |
| **USD-cent budget** | `budget_usd_cents` (same constraints; integer cents, not float) | Same as token budget. Either dimension hitting its cap halts the mission. |
| **Recursion depth** | Depths `0`, `1`, `2` are admitted; **`3` or beyond is rejected**. | `depth_exceeded` event written, the trigger does not reach the LLM. Negative / NaN / Infinity / non-numeric depths are coerced to `0` before the comparison so a caller cannot smuggle past the gate by sending `depth: -1`. |

**Atomicity.** `BudgetEnforcer.increment` runs inside `BEGIN IMMEDIATE` so two concurrent post-call increments cannot both read `spent < budget`, both decide to allow, and only then race on the UPDATE — the second caller blocks at BEGIN and observes the post-commit `spent`. The status flip and the `budget_exceeded` event are written in the same transaction, so a supervisor restart between them cannot leave a paused mission without its terminal event in the timeline.

**Warning band.** `BudgetEnforcer.check` returns `warn=true` once either dimension crosses 80% — the UI uses this to surface a banner one call before the halt.

**Per-call delta cap.** A single increment delta is rejected if it isn't a non-negative integer ≤ INT32_MAX. The DB column is INT64, but the service-layer ceiling defends against malformed `usage` rows from upstream providers that occasionally surface absurd token counts.

**Kill-switch.** Pausing a mission is the kill-switch. `BudgetEnforcer.check` returns `allowed=false` for any mission whose `status='paused'`, regardless of remaining budget — the gate stays armed across daemon restarts. To stop a runaway mission *right now*, `PATCH /missions/:id` with `{ "status": "paused" }`. The heartbeat scheduler unregisters its cron handle on the next tick (rogue-tick prevention re-reads `status` and bails if it isn't `active`), and the event subscriber drops further task-terminal triggers on the floor.

**What the guards do NOT do.** They do not police what the supervisor *proposes*. Destructive verbs (`delete`, `drop`, `remove`, `destroy`, `truncate`, `rm `) are rejected by the proposal schema at parse time, not by these guards. The guards exist to bound resource consumption; the schema exists to bound semantics.

## Approve / dismiss flow

Every proposal is a `mission_events` row with `kind='remediation_proposed'`. Its lifecycle is recorded by *follow-up* events whose payload references the proposal's id via `payload.proposal_event_id`:

- **pending** — a proposal with no later `remediation_dismissed` / `remediation_approved` row pointing at it.
- **dismissed** — has a later `remediation_dismissed` row.
- **approved** — has a later `remediation_approved` row, plus a freshly-created milestone / slice / plan-task in the plan store.

### From the UI

- **Project mission detail page** lists pending proposals at the top with **Approve** and **Dismiss** buttons. Approve materialises the proposed entity on disk; Dismiss records a `remediation_dismissed` event with an optional free-text reason (capped at 2000 chars, same upper bound as the proposal's own summary so a dismissal note can faithfully quote it).
- **Inbox** surfaces pending proposals across every project, alongside task approvals and permission requests. One-click jump lands you on the proposal's mission detail page.
- Both buttons are **idempotent** — a double-click never produces two timeline rows. The second click returns the same `decision_id` with `idempotent: true`.

### From the API

```
GET    /missions/:id/proposals?status=pending|dismissed|all   # default: pending
POST   /missions/:id/proposals/:pid/approve                    # body optional
POST   /missions/:id/proposals/:pid/dismiss                    # body: { "reason"?: string }
```

`:id` is the mission UUID; `:pid` is the `mission_events.id` of the `remediation_proposed` row. A 404 fires if either is missing OR if `:pid` resolves to a non-proposal event on the same mission, so a caller cannot approve a `task_observed` row by guessing its id.

**Approve re-validates.** The handler reconstructs a `proposalSchema`-shaped object from the stored payload (`payload.rationale` + `payload.proposal.{target_type, candidate}`) and runs it through the **same zod** the supervisor ran when it minted the proposal. A failure → `422` with the zod issue list, no entity created, no decision event written. This is a deliberate security invariant: a future attacker who forged a `mission_events` row with `kind='remediation_proposed'` and a malformed payload (or a destructive verb sneaked past a stale schema) cannot cash that row in for a real plan-store mutation.

**Approve materialises.** On success the handler routes by `target_type` to the existing plan-store creator — `createMilestone`, `createSlice`, or `createPlanTask` — so the on-disk shape matches what `POST /projects/:pid/milestones/...` would write. Approval is just a different entry point into the same authoring code path. The `candidate.action` becomes the entity title (truncated to 200 chars so the slug stays readable); the verbose `candidate.summary`, when present, becomes the description.

**Dismiss does not mutate the plan store.** It records `remediation_dismissed` with the optional `reason` and stops there. The proposal stays in the timeline, just no longer in `?status=pending`.

**Approval and dismissal events do NOT route through `guardedEvaluate`.** They are operator-driven, not LLM-driven, so the budget / depth gates don't apply (the operator already saw the proposal and is spending their own attention, not model tokens). Cost on these rows is hard-coded to `{tokens: 0, cents: 0}`.

### Timeline scan

```
GET /missions/:id/events?page=1&per_page=50      # cap 1000/page
```

Reverse-chronological, paginated, indexed on `(mission_id, created_at DESC)` from migration `0043`. Per-page cap is 1000 (vs the global 100/page default) because the supervisor timeline is the one surface where a single mission may legitimately want thousands of events at once — forensics export, "load entire timeline" view.

## Supervisor prompt versioning

The supervisor's prompt template is pinned to a version constant: **`SUPERVISOR_PROMPT_VERSION`** in [`src/services/missions/supervisor-prompt.ts`](../src/services/missions/supervisor-prompt.ts). It appears verbatim on the first line of every rendered prompt — `You are the mission supervisor (prompt v1.0.0).` — and is also stamped into `missions.supervisor_prompt_version` at creation time so an old mission's events can be correlated with the prompt revision that produced them.

**Why a version pin.** Two reasons, both load-bearing:

1. **Provider-side cache busting.** Anthropic's prompt cache hashes the prefix of the request. A version constant baked into the instructions block forces a cache miss the moment the template's text or structure changes, so a stale cache entry can never serve the new template's output under the old contract.
2. **Forensic correlation.** Mission events are append-only and live longer than any single template revision. Stamping the version on the mission row means a 6-month-old `remediation_proposed` event can be replayed against the exact template that produced it, even after the template has moved on.

**When to bump it.**

- **MAJOR / MINOR (`v1.0.0` → `v2.0.0` or `v1.1.0`)** — any change to the role line, the output contract, the structure of the trusted-context block, the data-fence warning, or the list of allowed JSON shapes. Anything a downstream parser or evaluator could observe.
- **PATCH (`v1.0.0` → `v1.0.1`)** — typo fixes and whitespace-only edits that don't change the model's effective interpretation. Still bump it: the cache-bust matters even when the semantics don't.

**When NOT to bump it.** Cosmetic edits to comments, JSDoc, or unrelated symbols in the same file are not template changes. The constant tracks the *rendered prompt's text*, not the source file's diff.

**The jailbreak regression suite pins exact strings.** [`src/__tests__/jailbreak-regression.test.ts`](../src/__tests__/jailbreak-regression.test.ts) and the version-pin test in slice 11/02 task 03 assert the rendered prompt byte-for-byte. Bumping the version without updating the snapshots fails CI; updating the snapshots without bumping the version fails the version-pin test. Both gates have to be satisfied in the same commit.

## Troubleshooting

### Supervisor isn't firing on task completion

Check, in order:

1. **Is the mission `active`?** `GET /missions/:id` — `status` must be `active`. `paused` (kill-switch), `completed`, `failed`, and `aborted` all suppress evaluation.
2. **Is the task in the same project as the mission?** The event subscriber resolves task → milestone → mission_id. A task in a sibling project or with no plan linkage is filtered out as orphan and never reaches the supervisor — by design.
3. **Did a previous evaluation crash?** Check `mission_events` for the most recent row. The subscriber serializes per-mission (running + at most one pending), so a hung in-flight evaluate would prevent later triggers from firing. Look for an absent terminal event on the previous trigger.
4. **Is the budget already paused?** A mission whose token or USD-cent budget hit its cap flips to `status='paused'` automatically and stays there. `GET /missions/:id` will show `status='paused'` even though you didn't pause it manually — search the timeline for a `budget_exceeded` event.
5. **Is the depth guard blocking?** A `depth_exceeded` event in the timeline means the supervisor's own proposal re-triggered itself past depth 2. The mission keeps running, but that specific trigger is dropped. The next non-recursive event will be evaluated normally.

### Events aren't appearing in the timeline

- **`GET /missions/:id/events` returns an empty list.** Verify the mission row exists (`GET /missions/:id`). The endpoint 404s on a missing mission and returns `{items: [], total: 0}` on a real-but-empty timeline — distinguishing the two is the first diagnostic.
- **A specific event you expected is missing.** All supervisor wake-ups flow through `guardedEvaluate`, which is the *only* writer of LLM-driven `mission_events` rows. If the trigger never reached `guardedEvaluate` (orphan filter, paused mission, coalesced into a later trigger), no row is written. Approve / dismiss events bypass `guardedEvaluate` and write through the dedicated handler — those should always appear immediately.
- **Heartbeat events stopped.** The 15-minute cron self-unregisters when it observes `status !== 'active'` (rogue-tick prevention). Flipping a mission back to `active` does not auto-rearm the cron in the current process — it rearms on the next daemon boot via `registerHeartbeats()`. Restart the daemon, or call `registerHeartbeat(missionId)` from a CLI shim if you have one wired.
- **Events look truncated or `_parse_error: true`.** The events endpoint hand-decodes `payload` JSON defensively so a single malformed row doesn't poison the whole list response. A `_parse_error` flag on a payload means the underlying TEXT column has invalid JSON — almost always a sign of partial DB corruption or a manual edit. The supervisor itself never writes invalid JSON; `guardedEvaluate` runs the zod parse before the INSERT.

### Budget exhausted

When `BudgetEnforcer.increment` post-call sums hit the cap on either dimension:

1. The mission is **already paused** by the time you notice — atomically with the terminal event, in the same transaction.
2. The timeline has a **`budget_exceeded` event** with the post-call totals and the dimension that breached.
3. The supervisor will **refuse to evaluate** further triggers until you act, even if you flip the mission's `status` back to `active` without raising the cap (`BudgetEnforcer.check` reads the budget vs. spent comparison every call).

To recover, **`PATCH /missions/:id`** with one of:

- `{ "budgetTokens": <new_cap>, "budgetUsdCents": <new_cap>, "status": "active" }` — raise the ceiling and resume.
- `{ "status": "completed" }` — accept the mission as done at this spend.
- `{ "status": "aborted" }` — accept it as failed without further evaluation.

The integer caps must be `> 0` and `≤ INT32_MAX` (2,147,483,647). Ints, not floats — USD spend is tracked in cents specifically so a running total can't drift on float addition.

**Why not "auto-raise on warn"?** The 80% `warn=true` signal is informational. Auto-raising would defeat the budget's purpose — it's a ceiling, not a suggestion. The UI surfaces the warning so a human can decide before the halt; the halt itself is the contract.

---

## See also

- [CONCEPTS.md §Missions](CONCEPTS.md#missions) — the user-facing glossary entry.
- [ARCHITECTURE.md §Missions subsystem](ARCHITECTURE.md#missions-subsystem) — where the components live in the codebase.
- [AGENTS.md §Supervisor sessions](../AGENTS.md#supervisor-sessions) — the supervisor's contract from the agent's point of view (read this if you're writing supervisor-side code, not if you're an operator).
- [API.md](API.md) — exact request / response shapes for the `/missions` router.
