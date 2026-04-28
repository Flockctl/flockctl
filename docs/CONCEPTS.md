# Concepts

A user-oriented guide to the vocabulary of Flockctl: what each thing is, why it exists, and how you'll use it day-to-day. If you want the exact request shapes or table definitions, jump to [API.md](API.md) and [DATABASE.md](DATABASE.md).

## The big picture

```
┌ Workspace ────────────────────────────────────────────────────┐
│                                                               │
│   ┌ Project (git repo) ─────────────────────────────────────┐ │
│   │                                                         │ │
│   │   ┌ Milestone ──────────────────────────────────────┐   │ │
│   │   │   ┌ Slice ─────────────────────────────────┐    │   │ │
│   │   │   │   Plan-Task → Plan-Task → …            │    │   │ │
│   │   │   └────────────────────────────────────────┘    │   │ │
│   │   └─────────────────────────────────────────────────┘   │ │
│   │                                                         │ │
│   │   Task (executes a Plan-Task, or one-off prompt)        │ │
│   │   Chat (interactive AI session)                         │ │
│   │   Template ──► Schedule ──► recurring Task              │ │
│   └─────────────────────────────────────────────────────────┘ │
│                                                               │
│   Skills / MCP servers / Keys / Secrets scope across all      │
└───────────────────────────────────────────────────────────────┘
```

Think of Flockctl as three layers stacked on top of your code:

1. **Organization** — *where* work lives. Workspaces group related projects; a project is one repo.
2. **Planning** — *what* you want to do, broken down. Milestones contain slices, slices contain plan-tasks.
3. **Execution** — *the agent actually doing it*. Tasks and chats are where Claude runs, produces output, and makes changes.

Everything else (skills, MCP servers, keys, budgets, secrets) is shared plumbing that cuts across these layers.

---

## Organization

### Workspace

A workspace is a **folder of related projects** with shared settings. Use it when you have several repos that share the same AI keys, the same default permission mode, or the same skills and you don't want to configure each one separately.

*Example:* an `engineering` workspace grouping your `backend`, `frontend`, and `infra` repos — all of them share the company Anthropic key and the same default permission policy.

**When to create a new workspace:** different team, different client, or a different security boundary (e.g. you want production repos to use a dedicated key that development repos can't touch).

**What it gives you:**

- One place to restrict which AI keys its projects may use.
- Default permission mode inherited by every project inside it.
- A shared pool of skills and MCP servers (see *Skills* and *MCP*).
- A workspace-level dashboard showing aggregate activity and cost.

Workspaces are optional — a project can live on its own without one.

### Project

A project is **one git repository** that Flockctl will run tasks and chats against. It tracks which branch to work on, which AI model to use, which permission mode the agent runs under, which skills apply, and so on.

*Example:* `my-backend`, checked out on `main`, using Claude Sonnet with the `acceptEdits` permission mode and a nightly security-audit schedule.

Most project settings live in a `.flockctl/config.json` file inside the repo, so when you clone the repo elsewhere the settings come with it. The file is git-tracked on purpose — that way teammates pick up the same defaults.

**Things you configure per project:**

- Default AI model, plus a separate model for planning if you want one.
- The base branch for generated work.
- A test command the agent can run to verify itself.
- Timeouts and maximum concurrent tasks.
- Whether tasks require human approval by default.
- Environment variables the agent sees.
- Permission mode (overrides the workspace default).
- Skills and MCP servers you want disabled in this project specifically.

Every task and every chat must belong to a project.

### View mode

A **view mode** is how the project-detail page is laid out. The same underlying data — milestones, slices, plan-tasks — is rendered three ways, and you switch between them from the segmented toggle at the top of the page. The three modes are distinct surfaces, not cosmetic re-skins: pick the one that matches the question you're answering right now.

- **Tree view** — the default. A left-rail outline of milestones and their slices; clicking a node opens the detail panel on the right. Best when you want to navigate the plan hierarchy or bounce between neighbouring slices quickly.
- **Board view** — a Kanban-style board that groups slices into status columns (pending / active / completed, plus an "Other" fallback for any status the columns don't cover — `verifying`, `merging`, `skipped`, `failed`). The `verifying` column is hidden by default because the auto-executor doesn't transition slices into that state today; it will be reinstated once the backend starts emitting it. Best when you're trying to see "what's in flight right now" across a whole milestone.
- **Swimlane view** — planned layout that arranges slices along dependency lanes. Currently a "coming soon" stub behind the toggle; selecting it renders a placeholder instead of crashing, and the underlying shell is identical to Board view so wiring the real layout later is purely a panel change.

The active mode is stored in the URL as the `?view=` query param (`?view=board`, `?view=tree`, or `?view=swimlane`) so deep links and browser back/forward restore it; the last choice per project also persists in `localStorage` as a fallback. Any unrecognised value — empty string, a retired mode name, an injection payload — silently falls back to `tree` instead of throwing.

The tasks page has its own mode switch (table vs. grouped cards), but the concept is the same: the URL is the source of truth, the layout is purely presentation over the same task list.

---

## Planning hierarchy

Flockctl treats planning as its own layer: you can plan without ever executing, and you can execute without ever planning. When you do plan, the hierarchy is **milestone → slice → plan-task**, stored as markdown files in your repo so the plan lives alongside the code it describes.

Why three levels? Because real projects rarely fit in one. A milestone is "the thing we want at the end". A slice is "one PR's worth of work". A plan-task is "one prompt I can hand to an agent".

### Milestone

The **top of the plan** — a large goal or release. A milestone says *where* you want to end up and what has to be true when you get there.

*Example:* `v2.0 release`, with a vision of "rewrite auth, ship new billing, deprecate the old API".

A milestone typically captures:

- The vision (what this release is *for*).
- Success criteria (how you'll know you're done).
- Dependencies on other milestones.
- Key risks and a proof strategy.
- Definition of done.

Milestones move through statuses as you work on them: **pending → planning → active → completed**.

### Slice

A slice is a **deployable chunk** under a milestone — usually one coherent feature, migration, or refactor that could ship on its own. Slices are where the real work happens: you can fan out independent slices in parallel and run dependent ones in order.

*Example (inside the `v2.0 release` milestone):* `authentication redesign`, which depends on `database schema migration`.

A slice carries acceptance criteria, known risks, and estimates for tokens and cost. When you kick off auto-execution on a slice, Flockctl runs its plan-tasks in order, pausing to verify and merge between them.

Slice statuses: **pending → planning → active → verifying → merging → completed**, with **skipped** or **failed** as error exits.

### Plan-task

The **leaf of the plan** — one concrete unit of work the agent will be asked to do. A plan-task is essentially a stored prompt with some context around it. When it runs, Flockctl creates an execution **Task** (see below) and links them together.

*Example (inside the `authentication redesign` slice):* `implement OAuth2 handler`.

Plan-tasks are short-lived: **pending → active → completed** (or **failed**).

The whole plan lives under `<project>/.flockctl/plans/` as git-friendly markdown, so diffs show how the plan changes over time.

---

## Missions

A **mission** is a long-running, *supervised* goal that lives on top of a project. Where a slice or plan-task is "one PR's worth of work" or "one prompt", a mission is "keep watching this objective and propose the next move whenever something changes". Missions are how Flockctl handles work that isn't a single hand-off — recurring quality goals, ongoing investigations, or anything where the right next action depends on what just happened.

*Example:* a `keep main green` mission watches every task that runs against the project; when a build fails, the supervisor proposes opening a focused remediation slice. The proposal lands in the approval queue, you approve it, and Flockctl files the slice for you.

**The mission loop, end to end:**

1. You create a mission with an **objective** (one sentence — what success looks like) and a **budget** (tokens + USD ceiling).
2. Triggers fire: a task ends, a heartbeat ticks, the stalled-detector notices no progress.
3. The **supervisor** — a read-only Flockctl agent session — wakes up, looks at the trigger, and emits a single JSON reply: either a `propose` with a concrete next action, or a `no_action` with a reason.
4. Every supervisor round-trip is metered: a budget enforcer refuses to evaluate once you're out of tokens or dollars, and a depth guard caps recursion when the supervisor's own proposals would re-trigger it.
5. Proposals land in the **approval queue**. Nothing mutates the plan until you approve. Rejecting a proposal is a first-class outcome — it's recorded, and it's safe.
6. Every step — proposal, approval, rejection, budget reject, parse failure — is appended to a mission event timeline, so the mission has a full audit trail.

**Why supervisors don't act on their own.** The supervisor is structurally a *proposer*. It runs under a narrower contract than a normal task or chat session: it has no plan-mutation tools, its output is JSON-only, destructive verbs (`delete`, `drop`, `remove`, `destroy`, `truncate`, `rm `) are rejected at parse time, and the mission objective + trigger envelope are assembled from trusted DB rows — never from user input the supervisor reads. If something looks like an instruction inside the trigger payload, it's data, not a directive.

**Autonomy in v1.** Mission autonomy has two settings on paper — `proposal` (queue everything for human approval) and `auto` (apply without approval). In v1, only `proposal` is active; `auto` is disabled at the daemon level. Every proposal lands in the queue.

**Where missions show up in the UI:**

- The project tree gains a **Missions** node listing every mission attached to the project.
- Each mission has a detail page showing objective, budget burn-down, the supervisor log, and pending proposals.
- The global **Inbox** surfaces pending mission proposals alongside task approvals and permission requests.

For the deeper specification — event schema, guard behaviour, prompt versioning, and the supervisor's exact contract — see [MISSIONS.md](MISSIONS.md). For where the components live in the codebase, see [ARCHITECTURE.md §Missions subsystem](ARCHITECTURE.md#missions-subsystem).

---

## Execution

### Task

A task is **one execution** — a prompt sent to an AI agent, a status, and all the output the run produced. Every action that modifies your code goes through a task, so the task is also your audit trail.

*Example:* "Add TypeScript types to the auth module" — runs via Claude Code, produces git changes, waits for approval before merging.

A task captures everything you need to reproduce or inspect the run later:

- The prompt and agent used.
- The working directory and environment.
- Which AI key and model actually ran.
- Git commit before and after, plus a diff summary.
- Full stdout / stderr.
- Cost and token usage.
- Approval state, if it was gated.

**How a task moves through its life:**

```
queued ──► running ──► done
              │  ▲
              │  ╰──── waiting_for_input (agent asked, user answers)
              │
              ├──► failed ──► queued    (automatic retry)
              ├──► cancelled ──► queued (you clicked rerun)
              ├──► timed_out ──► queued (exceeded timeout, rerun)
              └──► pending_approval ──► done
                                    ╰─► cancelled
```

- **queued** — waiting for a worker.
- **running** — the agent is actively executing.
- **concurrency scope** — capacity is enforced per selected AI Provider Key (default: 5 concurrent tasks per key), not as one global process-wide cap.
- **waiting_for_input** — the agent called `AskUserQuestion` and is parked until the user answers. No tokens accrue and the task no longer counts against the concurrency budget. Answering flips it back to `running`; if the daemon restarted while parked, answering flips it back to `queued` and execute() resumes the prior Claude Code session via `claudeSessionId`.
- **pending_approval** — the agent stopped and is waiting for a human to approve or reject its changes.
- **done** — finished successfully.
- **failed / cancelled / timed_out** — something went wrong. You can re-run it, which copies the config into a fresh task.

**Approval gate.** If a task (or its slice, or its project config) requires approval, the agent pauses when it thinks it's done and the task goes into `pending_approval`. You either approve it (optionally with a note) or reject it — rejection reverts any git changes the task made.

**Task types.** Most tasks are `execution`, but Flockctl also marks `planning`, `verification`, and `merge` tasks internally so the UI can show them differently.

### Task log

The **stdout/stderr stream** a task produces, stored line by line. While the task is running, new log lines stream to the UI in real time; once it's finished, the log is still there so you can scroll back through it.

### Task template

A **reusable task recipe**. You set the prompt, model, timeout, working directory, env vars, and preferred key once, and then either spawn tasks from it on demand ("named presets") or attach a schedule to it for recurring runs.

*Example:* a `daily security audit` template that runs a stock prompt against a specific directory with a fixed timeout.

### Schedule

A **when** attached to a template. Schedules come in two flavors:

- **cron** — fire on a repeating pattern (e.g. `0 9 * * 1-5` for 9 AM on weekdays).
- **one-shot** — fire once at a specific time.

Schedules can be paused and resumed. When a schedule fires, it creates a new task from its template and queues it like any other.

---

## Conversation

### Chat

A **multi-turn AI session** scoped to a project (or sometimes a whole workspace). Chats are for the interactive, conversational work that doesn't fit neatly into a one-shot task: brainstorming, debugging back-and-forth, exploring a codebase.

*Example:* "brainstorm v2.0 features" — you open a chat against the project, talk through ideas with Claude, and come back to it later to keep the thread going.

Chats:

- Survive restarts. You can close the UI, come back tomorrow, and continue the same conversation.
- Stream responses live over SSE as the model generates them.
- Can be **linked to a planning entity** (a milestone, slice, or task). When linked, the agent has that context automatically.
- Track token and cost usage per message.
- Can be cancelled mid-turn if the agent is going down the wrong path.

### Chat message

One **turn** inside a chat — either from you (`user`), from the agent (`assistant`), or an internal `system` note. Messages are immutable once sent; to "correct" something you start a new turn.

### Permission request

When the agent tries to use a gated tool (running a shell command, writing a file, editing code) and the current permission mode says "ask first", the agent **pauses and raises a permission request**. You get a prompt in the UI — approve, or deny. Until you answer, the agent is waiting.

Permission requests happen inside both tasks and chats.

### Agent question

Distinct from a permission request: the agent can also stop and ask you a **free-form clarification question** via the `AskUserQuestion` tool — "what port should I bind to?", "which of these two files did you mean?". The question is persisted in the `agent_questions` table so it survives daemon restarts, and is surfaced in the `/attention` inbox alongside pending permissions.

- **For tasks**, emitting a question flips the task into `waiting_for_input` (see the task lifecycle above). Budget and concurrency accounting stop for the duration.
- **For chats**, there is no status column — a chat is treated as waiting whenever `EXISTS(pending agent_question WHERE chat_id = <id>)`. The UI re-hydrates the pending question on page reload by calling `GET /chats/:id/pending-questions`.

Answering uses `POST /tasks/:id/question/:requestId` or `POST /chats/:id/question/:requestId` with `{ answer: "…" }`. If the daemon restarted while the task was parked, the hot-path handoff to the live session is skipped — the answer is persisted, the task flips to `queued`, and the scheduler resumes the prior Claude Code session via `claudeSessionId`.

### Permission mode

The **policy** that decides which tool calls need your approval. You pick this at the project or workspace level, and you can override it on a specific task or chat.

| Mode | What happens |
|------|--------------|
| `default` | The agent asks for every risky tool call. |
| `acceptEdits` | File edits go through automatically; shell commands still ask. |
| `plan` | The agent plans but never actually runs anything (full dry-run). |
| `bypassPermissions` | Everything is auto-approved. Only use for trusted automation. |
| `auto` (default) | Safe tools auto-approved, risky ones ask. |

**Inheritance:** a task's mode wins if set, otherwise the chat's, otherwise the project's, otherwise the workspace's, otherwise `auto`.

---

## Extensibility

### Skill

A **capability file** — a prompt fragment, workflow description, or code snippet — that Claude loads when it runs against your repo. Skills are how you teach the agent "here's how we do things in this codebase".

Skills live at three tiers and stack:

- **Global** — available to every project on this machine.
- **Workspace** — available to every project in a workspace.
- **Project** — only in this specific project.

When two tiers define a skill with the same name, the more specific one wins (project overrides workspace overrides global). You can also **disable** a skill you inherited without having to edit the tier that defined it.

*Example:* a global `git-workflow` skill describing your usual branch and PR style, with a project-level override for a monorepo that follows a different flow.

### MCP server

An **external tool the agent can call**, wired in through the [Model Context Protocol](https://modelcontextprotocol.io/). MCP servers give the agent access to things outside the repo — a Postgres database, a company internal API, a documentation store, etc.

Same three-tier resolution as skills (global / workspace / project), same overriding behavior, same ability to disable an inherited server you don't want in a particular project.

### Agent

The **AI backend** actually running a task or chat. Today that's Claude Code (via the Claude Code CLI or the Claude Agent SDK). The field exists so Flockctl can grow support for other agents later; in practice you pick Claude Code and forget about it.

### Hook

A **shell command that fires on a harness event** (e.g. after every model response, before the session stops). Hooks are configured in Claude Code's own settings, not in Flockctl. They're useful for automated behaviors like "play a sound when a task finishes" or "log every tool call to a file".

---

## Keys & cost

### AI provider key

The **credential Flockctl uses to talk to Claude** (or another provider). A key can be supplied four different ways, and you can mix and match:

- **Direct value** — paste the API key.
- **CLI command** — a shell command that prints a fresh key (useful for short-lived tokens).
- **Environment variable** — Flockctl reads `ANTHROPIC_API_KEY` or whichever you name.
- **Config directory** — point at a Claude CLI config dir and Flockctl picks up whatever's logged in there.

You can have many keys at once. Each one has a **priority** (higher = tried first) and an **error counter** — after too many consecutive failures, Flockctl temporarily disables the key and falls back to the next one. You can also disable a key manually.

*Example:* two Anthropic keys (work + personal) with work at higher priority; Flockctl automatically falls back to personal if work hits a rate limit.

### Key scoping

A workspace or project can **restrict which keys are eligible**. Set `allowedKeyIds` on a workspace to say "only these keys may be used by any project inside me". Set it on a project to narrow further. If nothing is set, all active keys are eligible.

*Example:* "only the company key runs in production repos" — set the allow-list on the production workspace.

### Usage record

A **cost-tracking row** written every time the agent calls a model. Each record captures which task or chat message it came from, which key and model ran, how many tokens (input, output, cache-write, cache-read) were used, and the USD cost. The cost dashboard aggregates these records; they're also what the budget limits are checked against.

Usage records outlive their parent — deleting a task does not erase its cost history.

### Budget limit

A **spending cap** with an action attached. You can set a cap globally, per workspace, or per project, over a period (daily / monthly / total).

Two actions:

- **pause** — Flockctl refuses to start new tasks or chat turns once the cap is hit, until the period resets or you raise the cap.
- **warn** — still run, but surface a warning in the UI.

*Example:* "$10/day globally, pause at the limit" means at most ten dollars of Claude cost per day across everything.

### Secret

An **encrypted key-value entry** for sensitive values that your MCP servers or task environments need to reference. Secrets are stored encrypted on disk; you reference them in configs via `${secret:NAME}` placeholders and Flockctl substitutes them at run time.

Secrets are scoped the same way as keys and configs — **global**, **workspace**, or **project** — so a project can have its own `DATABASE_URL` without leaking it into other projects on the same machine.

*Example:* store `STRIPE_LIVE_KEY` as a project-scoped secret and reference it from the project's MCP server config — the secret never ends up in the repo.

---

## Attention

**Items blocked on you.** Attention is a live, derived view of everything waiting on a human — tasks in `pending_approval`, chats or tasks paused on a tool permission request. It lets you see at a glance whether anything is stalled without hunting through projects.

**Kinds of blockers:**

- **Task approval** — a task waiting for you to approve or reject its git changes.
- **Tool permission** — a chat or task paused on a permission request for a gated tool.

**Where it appears in the UI:**

- **Sidebar badge** — total count across all projects.
- **Inbox page** — full list, grouped by project, with one-click jump to the blocked item.
- **Project indicators** — each project card shows a badge if something inside it is waiting.

Attention is **not persisted** — it's derived live from the current state of tasks and chats, so there's nothing to reconcile or migrate.

See also: [Permission request](#permission-request), [Permission mode](#permission-mode), task `pending_approval` status.

---

## How it all fits together

A typical day looks like:

1. You **open a chat** against a project to think through a feature. The chat picks up the project's model, permission mode, skills, and keys automatically.
2. You ask the agent to **draft a plan**. It writes a milestone with a couple of slices and plan-tasks into `.flockctl/plans/`. You review the markdown in the UI and edit anything you don't like.
3. You **kick off auto-execution** on a slice. Flockctl walks the plan-tasks in order, spawning a real **task** for each one. Each task streams logs live and commits its changes to git.
4. A task hits an edit the agent isn't sure about — it raises a **permission request**. You approve it from the UI and the task continues.
5. The slice finishes, and because your project is configured to require approval, the final task sits in **pending_approval**. You skim the diff, approve with a note, and the task is **done**.
6. Overnight, a **schedule** fires your `daily security audit` **template**, creating a fresh task that runs while you sleep and drops its findings as logs for you to read in the morning.
7. Throughout all of this, **usage records** accumulate — by noon your **budget limit** fires a warning that you're on track to exceed the daily cap, so you pause the scheduled auto-execution and finish the day manually.

---

## See also

- [GETTING-STARTED.md](GETTING-STARTED.md) — 10-minute walkthrough that creates one of each of these.
- [CLI.md](CLI.md) — the commands that drive them from the terminal.
- [API.md](API.md) — exact request / response shapes.
- [CONFIGURATION.md](CONFIGURATION.md) — every setting you can put in `.flockctl/config.json`.
