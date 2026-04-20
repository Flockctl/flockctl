# Getting started

A 10-minute walkthrough from fresh install to your first completed task. Assumes you've finished [INSTALLATION.md](INSTALLATION.md) and `flockctl start` is running.

We'll use the REST API with `curl` so you can follow along without the UI. The same flow is available point-and-click at `http://127.0.0.1:52077`.

## 0. Sanity check

```bash
curl http://127.0.0.1:52077/health
# {"status":"ok","version":"1.0.0","hostname":"..."}
```

If this fails, see [INSTALLATION.md](INSTALLATION.md) and [CLI.md](CLI.md).

## 1. Add an AI provider key

Flockctl doesn't ship with a default key — you bring your own Claude credentials. Today Flockctl drives **Claude only** (via the Claude Code CLI or the Anthropic API); support for OpenAI / Gemini is on the roadmap but not wired up.

### Claude CLI (simplest if you have `claude` installed)

```bash
curl -X POST http://127.0.0.1:52077/keys \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude_cli",
    "providerType": "claude-agent-sdk",
    "label": "local claude CLI",
    "cliCommand": "claude"
  }'
```

### Anthropic API key

```bash
curl -X POST http://127.0.0.1:52077/keys \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "anthropic",
    "providerType": "anthropic-messages",
    "label": "personal anthropic",
    "keyValue": "sk-ant-api..."
  }'
```

`GET /keys` returns the configured keys (the `key_value` is redacted).

```bash
curl http://127.0.0.1:52077/keys
```

## 2. Create a project

A project is a named bundle of configuration (model, agent, permission mode, …) attached to a filesystem path — typically a git repo.

```bash
curl -X POST http://127.0.0.1:52077/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "hello-flockctl",
    "description": "First project",
    "path": "/Users/me/code/hello-flockctl",
    "model": "claude-sonnet-4-6",
    "baseBranch": "main",
    "permissionMode": "acceptEdits"
  }'
# → {"id": 1, "name": "hello-flockctl", ...}
```

Note the `id` — you'll pass it to the task in the next step.

Only `name` is strictly required. `path` defaults to a Flockctl-managed workspace directory if omitted; `model` / `baseBranch` / `permissionMode` are stored in the project's config and used as defaults for every task that doesn't override them.

### About `permissionMode`

Agents like Claude Code request permission before invoking destructive tools. The four modes control how strict that gate is:

| Mode | Behavior |
|------|----------|
| `default` | Ask for every risky tool call |
| `acceptEdits` | Auto-approve file edits, still ask for shell |
| `plan` | Agent plans but never runs tools — useful for dry-runs |
| `bypassPermissions` | Auto-approve everything — only for trusted automation |

## 3. Create and run a task

Tasks are prompts routed to an agent. Creating one is enough — execution starts automatically.

```bash
curl -X POST http://127.0.0.1:52077/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": 1,
    "prompt": "List the files at the repository root and summarise the project in one paragraph.",
    "label": "my first task"
  }'
# → {"id": 1, "status": "queued", ...}
```

Poll it:

```bash
curl http://127.0.0.1:52077/tasks/1
# {"id": 1, "status": "running", "startedAt": "...", ...}
# → later
# {"id": 1, "status": "completed", "completedAt": "...", "outputSummary": "..."}
```

## 4. Watch the log live

For interactive runs, attach to the WebSocket log stream instead of polling:

```bash
# Any WS client will do — this uses `websocat`
websocat "ws://127.0.0.1:52077/ws/ui/tasks/1/logs"
```

Events stream in as the agent thinks, invokes tools, and writes output. See [PROTOCOL.md](PROTOCOL.md) for the event shapes.

## 5. Browse the UI

The web UI renders all of the above plus planning, chats, schedules, skills, MCP, and cost dashboards:

```bash
open http://127.0.0.1:52077
```

Log in as any of your existing projects — no auth screen in local mode.

## Where to go next

- **Plan bigger work.** Break a project into milestones and slices with the planner. See [CONCEPTS.md](CONCEPTS.md) and [API.md](API.md) (`/projects/:id/milestones`).
- **Go multi-device.** Enable remote access with labeled tokens — [REMOTE-ACCESS.md](REMOTE-ACCESS.md).
- **Multiple Claude accounts.** Isolate credentials per backend — [MULTI-ACCOUNT.md](MULTI-ACCOUNT.md).
- **Understand the terminology.** [CONCEPTS.md](CONCEPTS.md) is the one-page glossary.
- **Automate.** Hook up schedules (`/schedules`) or drop task templates (`/templates`) for repeat work.
