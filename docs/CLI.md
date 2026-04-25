# CLI reference

Flockctl exposes one binary, `flockctl`, with subcommands for lifecycle (`start` / `stop` / `status`), token management (`token generate` / `list` / `revoke`), project and workspace management (`project ...` / `workspace ...`), and state-machine validation (`state-machines check`). Long-running operations like task execution and chat happen through the API or web UI, not the CLI.

### Daemon-facing commands

Everything under `flockctl project ...` and `flockctl workspace ...` talks to the local daemon over HTTP. They honour these environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `FLOCKCTL_HOST` | `127.0.0.1` | Daemon host |
| `FLOCKCTL_PORT` | `52077` | Daemon port |
| `FLOCKCTL_TOKEN` | — | Bearer token to send as `Authorization: Bearer …`. On loopback no token is required; when targeting a non-loopback host and this var is unset, the CLI falls back to the first token in `~/.flockctlrc` |

Every `<idOrName>` argument accepts either a numeric id (e.g. `12`) or the case-insensitive name (e.g. `my-project`). Names that match more than one row are rejected with an error listing the candidate ids.

## `flockctl start`

Start the daemon in the background. Writes the PID to `~/flockctl/flockctl.pid` and logs to `~/flockctl/flockctl.log`.

```bash
flockctl start [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <number>` | `52077` | HTTP port |
| `-H, --host <address>` | `127.0.0.1` | Bind interface. `127.0.0.1` / `::1` / `localhost` are always accepted. Any other address requires a configured token or `--allow-insecure-public` |
| `--allow-insecure-public` | off | Allow binding to a non-loopback interface with no authentication. Prints a `[SECURITY WARNING]` on every startup |

### Bind-security matrix

| Host | Token configured? | `--allow-insecure-public`? | Result |
|------|-------------------|---------------------------|--------|
| `127.0.0.1` / `::1` / `localhost` | — | — | Start silently |
| non-loopback (e.g. `0.0.0.0`) | yes | — | Start, log `Remote access enabled on http://HOST:PORT (token auth active)` |
| non-loopback | no | yes | Start, log `[SECURITY WARNING] ...` |
| non-loopback | no | no | **Refuse**, exit 1 with guidance |

See [REMOTE-ACCESS.md](REMOTE-ACCESS.md) for the full remote-mode walkthrough.

### Examples

```bash
flockctl start                                           # loopback, default port
flockctl start -p 8080                                   # loopback, custom port
flockctl start --host 0.0.0.0                            # all interfaces — token required
flockctl start --host 0.0.0.0 --allow-insecure-public    # break-glass, no auth
```

## `flockctl stop`

```bash
flockctl stop
```

Sends `SIGTERM` to the PID in `~/flockctl/flockctl.pid`, then polls that PID until the daemon actually exits (up to 15 s). The daemon uses that window to drain in-flight chat streams and flush each chat's Claude Code `session_id` to SQLite, which is what lets `claude --resume` pick the conversation back up after the next `flockctl start`. If the process doesn't exit within 15 s the CLI prints a warning and returns non-zero — it never SIGKILLs, because forcing the child to die mid-drain leaves stale session ids that silently break chat-resume. Does nothing if the daemon isn't running.

## `flockctl status`

```bash
flockctl status
```

Prints `Flockctl is running (PID: N).` or `Flockctl is not running.` — cleans up a stale PID file if the referenced process is gone.

## `flockctl token`

Manage labeled bearer tokens for remote access. All three subcommands edit `~/.flockctlrc` in place (chmod `600` is re-applied on every write).

### `flockctl token generate`

```bash
flockctl token generate [--label <name>] [--save]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-l, --label <name>` | `default` | Label to attach to the token. Must be unique |
| `--save` | off | Write the token to `~/.flockctlrc`. Without it, the token is printed but not persisted |

The token is 32 bytes from `crypto.randomBytes`, encoded as base64url. With `--save`, the full token is printed **exactly once** — copy it onto the calling device now.

```bash
flockctl token generate --label phone --save
# Token saved to ~/.flockctlrc (label: phone)
#
# Use this token in Authorization: Bearer <token> headers:
#
#   AbCdEf...base64url...
#
# This is the only time the full token will be shown. Store it securely.
```

Without `--save`, only the token is printed. Use this when a third party will write the config file for you (IaC, config management).

### `flockctl token list`

```bash
flockctl token list
# LABEL   FINGERPRINT
# phone   a1b2c3d4
# laptop  e5f6a7b8
```

Prints label + first 8 hex chars of `sha256(token)`. The full token is **never** printed — use the fingerprint to identify which label holds a particular token without exposing it.

Legacy single-string `remoteAccessToken` shows up as label `default`.

### `flockctl token revoke <label>`

```bash
flockctl token revoke phone
# Revoked token: phone
```

Removes the matching entry from `remoteAccessTokens`. If the label is `default` and the legacy single-string `remoteAccessToken` is present, that legacy field is also cleared. Exits 1 if no matching label exists.

### Legacy alias

`flockctl token` (no subcommand) is accepted as an alias of `flockctl token generate` and still works; new scripts should use the explicit form.

## `flockctl project`

Create, list, inspect, and delete projects. All commands here are thin wrappers over `/projects` HTTP endpoints — the daemon handles git init, `.flockctl/` scaffolding, AGENTS.md adoption, MCP reconciliation.

### `flockctl project add <path>`

Register a local directory as a flockctl project. The command first calls `POST /projects/scan` to detect conflicts. If an unmanaged `AGENTS.md`, a differing `CLAUDE.md`, or a populated `.mcp.json` is present, the command refuses to proceed without an explicit decision: pass the matching `--adopt-*` / `--merge-*` / `--import-*` flag, or `--yes` to accept every proposed action.

```bash
flockctl project add ./my-repo
flockctl project add ./my-repo --name widget --workspace main --adopt-agents-md
flockctl project add ./my-repo --yes --json
```

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --name <name>` | basename(path) | Project name |
| `-d, --description <text>` | — | Human-readable description |
| `-w, --workspace <id\|name>` | — | Attach to an existing workspace |
| `--repo-url <url>` | — | Git remote URL to record on the project |
| `-k, --allowed-key-ids <ids>` | — | Comma-separated numeric AI-provider-key IDs the new project may use (the daemon requires at least one active key on create) |
| `--adopt-agents-md` | off | Import an existing `AGENTS.md` into `.flockctl/AGENTS.md` |
| `--merge-claude-md` | off | Merge an existing `CLAUDE.md` into `.flockctl/AGENTS.md` |
| `--import-mcp-json` | off | Adopt servers from an existing `.mcp.json` |
| `-y, --yes` | off | Accept every proposed import action (incl. `.claude/skills`) and allow overwriting an already-managed directory |
| `--json` | off | Print the created project row as JSON |

### `flockctl project add-cwd`

Same as `project add` but uses `process.cwd()` as the path. All flags from `project add` are accepted.

```bash
cd ~/src/widget && flockctl project add-cwd --workspace main -y
```

### `flockctl project scan <path>`

Dry-run: prints what `project add <path>` would detect and propose. Read-only, does not touch the database.

```bash
flockctl project scan ./my-repo
flockctl project scan ./my-repo --json
```

### `flockctl project list`

```bash
flockctl project list                           # all projects
flockctl project list --workspace main          # only projects inside workspace "main"
flockctl project list --json
```

### `flockctl project show <idOrName>`

Prints id, name, description, path, repoUrl, workspace id, createdAt, and milestone count. Use `--json` for the full payload (includes the milestone list).

### `flockctl project update <idOrName>`

Patches an existing project. Only the flags you pass are changed — everything else keeps its current value. DB-row fields and per-project config (`<project>/.flockctl/config.json`) are both reachable.

```bash
flockctl project update widget --name widget-v2
flockctl project update 12 --model claude-sonnet-4-5-20250929 --base-branch main
flockctl project update widget --permission-mode acceptEdits --json
```

| Flag | Target | Description |
|------|--------|-------------|
| `-n, --name <name>` | DB | Rename the project |
| `-d, --description <text>` | DB | Replace the description |
| `-p, --path <dir>` | DB | Change the on-disk path recorded for the project |
| `--repo-url <url>` | DB | Update the git remote URL |
| `--model <model>` | config | Default model for tasks |
| `--planning-model <model>` | config | Model used by the planner |
| `--base-branch <branch>` | config | Base branch (e.g. `main`) |
| `--permission-mode <mode>` | config | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` |
| `--json` | — | Print the updated project as JSON |

Calling `project update` with no flags exits 1 with a message listing the available flags.

### `flockctl project rm <idOrName>` (alias: `remove`)

Deletes the project row and its associated secrets. By default the files on disk are untouched; pass `--purge` to recursively delete the project directory as well. Requires `-y, --yes` to proceed.

```bash
flockctl project rm widget --yes
flockctl project rm 12 --yes --purge       # also scrubs the on-disk directory
flockctl project remove widget --yes       # same as `project rm`
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt (required in non-interactive runs) |
| `--purge` | After the DB delete, recursively remove the project's on-disk directory (dangerous, irreversible) |

## `flockctl workspace`

Workspaces are directories that group related projects; their root `AGENTS.md` is prepended to the guidance every linked project sees, and their `.flockctl/config.json` cascades into every linked project.

### `flockctl workspace create <name>`

```bash
flockctl workspace create main
flockctl workspace create main --path ~/code/main --description "product team"
flockctl workspace create main --repo-url git@github.com:acme/main.git
```

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --path <dir>` | `~/flockctl/workspaces/<slug>/` | Local directory (created if absent) |
| `-d, --description <text>` | — | Description |
| `--repo-url <url>` | — | Git remote to clone into `--path` |
| `--json` | off | Print the created workspace as JSON |

### `flockctl workspace list`

### `flockctl workspace show <idOrName>`

Prints workspace metadata and the list of linked projects.

### `flockctl workspace rm <idOrName>`

Deletes the workspace row. Child projects are NOT deleted — their `workspaceId` is set to `NULL` so they become standalone. Requires `-y, --yes`.

### `flockctl workspace link <workspace> <project>`

Attach a standalone project to a workspace. Both arguments accept id or name.

```bash
flockctl workspace link main widget
```

### `flockctl workspace unlink <workspace> <project>`

Detach a project from its workspace; the project becomes standalone.

## `flockctl agents`

Inspect and migrate the layered AGENTS.md guidance that agent sessions actually see. These commands are fully filesystem-local — they do not talk to the daemon, so they work whether or not `flockctl start` is running. A path is considered a "known flockctl path" when it contains a `.flockctl/` scaffold directory on disk.

For the layering model, layer order, size caps, and wire format, see [AGENTS-LAYERING.md](AGENTS-LAYERING.md).

### `flockctl agents show <path>`

Render the merged `AGENTS.md` guidance for the given path. By default, `<path>` is treated as a **project root** and the full three-layer cascade is resolved:

1. user — `<flockctlHome>/AGENTS.md`
2. workspace-public — `<workspacePath>/AGENTS.md`
3. project-public — `<path>/AGENTS.md`

The workspace path is auto-discovered by walking up ancestors until a directory with its own `.flockctl/` scaffold is found. Pass `--workspace` to treat `<path>` as a workspace root instead — in that mode only the first two layers are resolved.

```bash
flockctl agents show <path> [--workspace] [--effective] [--layers]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace` | `false` | Treat `<path>` as a workspace root (resolves layers 1-2 only). Without this flag, `<path>` is treated as a project root. |
| `--effective` | `true` | Print the merged guidance string (default behaviour). Implicit — kept for forward compatibility. |
| `--layers` | `false` | Print a JSON summary with per-layer `{layer, path, bytes, truncated}` entries, `totalBytes`, and `truncatedLayers`. Does not print the actual guidance content. |

Output is pipe-friendly — no ANSI escapes, no colour codes. Errors and warnings go to stderr; the merged guidance / JSON summary goes to stdout. The command exits `1` if `<path>` is missing, is not a directory, or has no `.flockctl/` scaffold.

#### Examples

```bash
# Preview what a session rooted at ./my-project will see
flockctl agents show ./my-project > AGENTS.resolved.md

# Inspect only the workspace-level view
flockctl agents show /Users/me/flockctl/workspaces/team --workspace

# Check which layers are present and how big each one is
flockctl agents show ./my-project --layers
```

## `flockctl state-machines check`

Validate that every new state transition introduced in the current `git diff` is declared in the per-entity registry under `.flockctl/state-machines/*.md`. Designed to run as a pre-commit hook — exits `1` on violations, `0` otherwise.

```bash
flockctl state-machines check [--diff <ref>] [--files <glob>] [--cwd <path>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --diff <ref>` | `HEAD` | Git ref to diff against (becomes `git diff <ref>`). Use `--cached` to validate the staged index, or a branch/SHA to validate a range |
| `-f, --files <glob>` | — | Restrict detection to files matching this glob (e.g. `src/models/**/*.ts`). Uses `*`, `**`, `?` |
| `-C, --cwd <path>` | `process.cwd()` | Run as if from this directory |

### Registry format

Each entity lives in its own markdown file, with a Mermaid `stateDiagram-v2` code block declaring allowed transitions:

```markdown
<!-- .flockctl/state-machines/order.md -->
---
entity: order
---

# Order state machine

​```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> shipped : ship
    pending --> cancelled : cancel
    shipped --> delivered : deliver
​```
```

Entity name is read from (in order) the `entity:` YAML frontmatter key, a `<!-- entity: <name> -->` HTML comment, the first H1 heading, or the filename stem.

### Detection heuristics (v1)

The analyzer scans ADDED lines in the diff for three patterns:

1. **Explicit annotation** — highest confidence, recommended for production use:
   ```ts
   // @sm:order shipped -> cancelled
   // @sm order: shipped -> cancelled
   // flockctl-sm order shipped->cancelled
   ```
2. **Object literal** — any `{ from: 'X', to: 'Y' }` (optional `entity:` hint, optional `event:`). Without an `entity:` hint the transition is checked against every registered entity.
3. **Event call** — `.transition('<event>')` calls whose event name isn't declared in any registered entity are flagged as unknown events.

Add `// flockctl-sm-ignore` on the same or previous line to suppress a false positive.

### Output

```
src/models/order.ts:42  new transition shipped→cancelled not declared in registry
  registered: pending→shipped:ship, pending→cancelled:cancel, shipped→delivered:deliver
  Add to .flockctl/state-machines/order.md:
      shipped --> cancelled

1 state-machine violation found
```

### Pre-commit hook example

```bash
# .git/hooks/pre-commit
#!/usr/bin/env bash
exec flockctl state-machines check --diff HEAD
```

The default `--diff HEAD` scans both staged and unstaged changes — i.e. everything that would differ from the last commit. Pass a branch or SHA to validate a larger range (useful in CI).

## npm scripts

Scripts in `package.json` wrap common operations during development. They aren't required for end users.

| Script | What it does |
|--------|-------------|
| `npm run dev` | Run the server with `tsx watch` (hot-reload, loopback) |
| `npm run build` | Compile TypeScript, copy bundled skills, build the UI |
| `npm start` | Start the daemon via CLI (same as `flockctl start`) |
| `npm stop` | Stop the daemon via CLI |
| `npm run typecheck` | `tsc --noEmit` for the backend |
| `npm run typecheck:ui` | Type-check the UI |
| `npm test` | Vitest unit + integration suite |
| `npm run test:coverage` | Same, with v8 coverage |
| `npm run test:smoke` | Boot a real server and probe it |
| `npm run test:e2e` | UI E2E tests (Playwright) |
| `npm run test:live` | Live Anthropic/OpenAI/Claude CLI calls (opt-in) |
| `npm run db:generate` | Generate a new Drizzle migration from schema diffs |
| `npm run db:migrate` | Apply migrations manually (the daemon also runs them on boot) |

See [TESTING.md](TESTING.md) for the full test ladder.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Start refused (security gate, lock file, generic error) |
| non-zero forwarded | Child process (forked daemon) exited with that code |
