# Installation

Flockctl runs as a single Node process backed by a local SQLite file. No Docker, no external database, no runtime services.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | `>=20.0.0` | Enforced by `package.json#engines` |
| **npm** | Bundled with Node | Any compatible manager (pnpm, yarn) works for installs but is not tested in CI |
| **Git** | Any recent | Required for project repo operations |
| **Claude Code CLI** | optional | Needed only if you plan to use the `claude-code` agent backend |

Flockctl has been developed and tested on macOS and Linux. Windows users should run through WSL.

## Option 1 — npm registry (planned)

```bash
npm install -g flockctl
flockctl start
```

> **Not yet available.** Flockctl is not yet published to the npm registry. Until it is, install from source (below). This section will be removed when the package ships.

## Option 2 — from source

```bash
git clone <repo-url> flockctl
cd flockctl

npm install          # installs backend + UI deps
npm run build        # compiles TS, copies bundled skills, builds the UI

# Put `flockctl` on your PATH
npm link

flockctl start       # → http://127.0.0.1:52077
flockctl status
flockctl stop
```

`npm link` creates a global symlink to `./dist/cli.js`. If you don't want a global binary, invoke the CLI directly:

```bash
node dist/cli.js start
# or via the pre-wired npm scripts
npm start
npm stop
```

## What gets created on first run

| Path | Purpose |
|------|---------|
| `~/flockctl/flockctl.db` | SQLite database (WAL mode) |
| `~/flockctl/flockctl.pid` | Daemon PID file |
| `~/flockctl/flockctl.log` | Daemon stdout/stderr |
| `~/flockctl/workspaces/` | Project working directories created by the UI |
| `~/flockctl/skills/` | Seeded from `src/bundled-skills/` on first boot; safe to customize |
| `~/flockctl/mcp.json` | Global MCP server config (optional) |
| `~/.flockctlrc` | User config (model defaults, remote-access tokens, …) |

Override the data root with `FLOCKCTL_HOME=/custom/path` or `"home": "/custom/path"` in `~/.flockctlrc`. See [CONFIGURATION.md](CONFIGURATION.md).

## Upgrading from source

```bash
git pull
npm install
npm run build
flockctl stop && flockctl start
```

Migrations run automatically on startup — no manual step is required. Your data in `~/flockctl/` and `~/.flockctlrc` is preserved.

## Uninstalling

```bash
flockctl stop
npm unlink -g flockctl      # if you ran `npm link`
rm -rf ~/flockctl           # ⚠ deletes your database and workspaces
rm ~/.flockctlrc            # ⚠ deletes remote-access tokens and config
```

## Verifying the install

```bash
flockctl start
curl http://127.0.0.1:52077/health
# → {"status":"ok","version":"...","hostname":"..."}
flockctl stop
```

If `/health` answers, migrations ran, the scheduler booted, and the server is listening. Continue to [GETTING-STARTED.md](GETTING-STARTED.md) for your first project and task.
