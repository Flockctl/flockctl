# CLI reference

Flockctl exposes one binary, `flockctl`, with subcommands for lifecycle (`start` / `stop` / `status`) and token management (`token generate` / `list` / `revoke`). Long-running operations like project creation and task execution happen through the API or web UI, not the CLI.

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

Sends `SIGTERM` to the PID in `~/flockctl/flockctl.pid`, waits for in-flight chats to drain (up to 5 s), then removes the PID file. Does nothing if the daemon isn't running.

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
