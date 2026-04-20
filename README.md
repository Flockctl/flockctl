# Flockctl

**A local-first control plane for AI coding agents.**

Flockctl is a daemon that lets you plan work, run coding tasks on your own machine with Claude Code, track cost and status, and manage everything from a web UI or API — without Docker, external databases, or a cloud account.

```
┌─────────────────────────────┐
│  Web UI  ─  CLI  ─  API     │
└──────────────┬──────────────┘
               │ HTTP + SSE + WebSocket
┌──────────────▼──────────────┐
│      Flockctl daemon        │
│   scheduler · auto-executor │
│   planner · permission gate │
│   AI client · cost tracker  │
│                             │
│         SQLite (WAL)        │
└─────────────────────────────┘
```

## Why Flockctl

- **Local-first by default.** Binds to `127.0.0.1` only; your code, API keys, and task history never leave your machine unless you opt in.
- **One install, zero infra.** `npm install` + `flockctl start`. SQLite in WAL mode handles persistence; no Docker, Redis, Postgres, or queue broker.
- **Plan → slice → execute.** Break projects into milestones and slices, let the auto-executor fan out independent work in parallel, gate risky tool calls behind approval.
- **Claude-first today.** Runs Anthropic Claude via the Claude Code CLI / agent SDK. Multiple keys are supported with priority + automatic failover on rate limits. Other providers (OpenAI, Gemini) are on the roadmap but not wired up yet.
- **Cost visible by default.** Every session records tokens and USD; the UI breaks usage down by project, model, and key.
- **Multi-machine when you want it.** Opt into labeled bearer-token auth to reach the same daemon from a phone, laptop, or CI runner over VPN / tailnet / reverse proxy.

## What Flockctl gives you

| Capability | What it means |
|------------|---------------|
| **Workspaces** | Top-level grouping for related projects; share AI-key scoping across a set of projects |
| **Projects** | Git-backed path with per-project model, key scoping, and permission-mode settings |
| **Planning** | Milestones → slices → tasks hierarchy; LLM-generated or hand-edited |
| **Tasks** | Prompts routed to Claude (CLI or agent SDK) with live log streaming and approval gates |
| **Chats** | Multi-turn sessions with tool approval, streamed over SSE, resumable |
| **Auto-execution** | Dependency-aware scheduler that runs independent slices in parallel, stops on failure, resumes after restart |
| **Templates & schedules** | Reusable task recipes; cron-driven recurring runs |
| **Skills & MCP** | Global / workspace / project skill files and MCP server config, merged transparently at runtime |
| **Metrics** | Cost, duration, and throughput dashboards per project / model / key |

## Installation

```bash
# From npm (release candidate)
npm install -g flockctl@next
flockctl start        # http://127.0.0.1:52077
```

```bash
# From source
git clone <repo-url> && cd flockctl
npm install && npm run build
npm link              # puts `flockctl` on your PATH
flockctl start        # http://127.0.0.1:52077
```

> Pre-1.0 releases are published under the `next` dist-tag. `npm install -g flockctl` (without `@next`) will start resolving once the first stable `1.x` is cut.

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for prerequisites, platform notes, and the full source-install flow.

## Getting started

A 10-minute walkthrough — create a project, add an AI key, run your first task — lives at [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Documentation

| Start here | |
|---|---|
| [Getting started](docs/GETTING-STARTED.md) | First-run walkthrough |
| [Concepts](docs/CONCEPTS.md) | Glossary: project, slice, chat, workspace, skill, … |
| [Installation](docs/INSTALLATION.md) | npm + source + prerequisites |
| [CLI reference](docs/CLI.md) | Every command and flag |
| [Configuration](docs/CONFIGURATION.md) | Env vars and `~/.flockctlrc` |
| [Remote access](docs/REMOTE-ACCESS.md) | Multi-device tokens, reverse proxy, TLS |
| **Reference** | |
| [API](docs/API.md) | REST, SSE, WebSocket |
| [Architecture](docs/ARCHITECTURE.md) | Internals and data flow |
| [Database](docs/DATABASE.md) | Drizzle schema |
| [Protocol](docs/PROTOCOL.md) | Real-time event shapes |
| [Security](docs/SECURITY.md) | Threat model |
| [Deployment](docs/DEPLOYMENT.md) | Daemon ops, backup, health |
| [Development](docs/DEVELOPMENT.md) | Contributing and conventions |
| [Testing](docs/TESTING.md) | Test ladder and CI |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the list of notable changes per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/).

## License

See [LICENSE](LICENSE).
