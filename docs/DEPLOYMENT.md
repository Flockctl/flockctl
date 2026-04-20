# Deployment

Operational reference for running Flockctl as a background daemon. For install instructions see [INSTALLATION.md](INSTALLATION.md); for CLI flags see [CLI.md](CLI.md); for remote-access setup see [REMOTE-ACCESS.md](REMOTE-ACCESS.md); for config fields see [CONFIGURATION.md](CONFIGURATION.md).

## Process model

```
flockctl start
    │
    ▼
cli.ts ─► daemon.ts ─fork()─► server-entry.ts (detached child)
                │                  │
                │                  ├─ runs migrations
                │                  ├─ seeds default key / bundled skills
                │                  ├─ reconciles plan + resumes stale milestones
                │                  ├─ starts HTTP + WS server
                │                  └─ IPC "ready" ─► parent writes PID file + exits
                │
                ▼
        ~/flockctl/flockctl.pid
```

- `flockctl start` forks `server-entry.js` with `detached: true` and an IPC channel.
- Child sends `"ready"` once the server is listening; parent writes the PID to `~/flockctl/flockctl.pid`, disconnects, and exits.
- If the child exits before "ready" (crash, bind refused, security gate refusal), the CLI surfaces the exit code and points you to `~/flockctl/flockctl.log`.
- A 10-second start timeout catches hangs.

## Lifecycle

### Start

```bash
flockctl start                        # defaults: 127.0.0.1:52077
flockctl start -p 8080
flockctl start --host 0.0.0.0         # requires a configured token — see REMOTE-ACCESS.md
```

On boot the daemon:

1. Runs the **security gate** — refuses to start on a non-loopback host without a token unless `--allow-insecure-public` is set.
2. Back-fills config fields from the DB into `~/.flockctl/config.json` (migration-safe).
3. Runs Drizzle migrations.
4. Seeds bundled skills into `~/flockctl/skills/` (skips anything already there).
5. Re-queues tasks that were left `running` by a previous instance.
6. Reconciles plan-task statuses with completed execution tasks.
7. Resumes stale auto-executing milestones.
8. Starts the scheduler (loads existing cron schedules).
9. Starts the HTTP + WebSocket server.
10. Re-executes the tasks from step 5.
11. Signals the parent with `ready`.

### Stop

```bash
flockctl stop
```

Sends `SIGTERM` to the PID. The signal handler:

1. Stops the scheduler.
2. Cancels all running tasks.
3. Cancels all running chats.
4. Waits up to 5 s for chats to drain (so SSE handlers finish saving the assistant message — losing this is a known source of lost work on every restart).
5. Closes every WebSocket.
6. `process.exit(0)`.

The CLI removes the PID file after sending the signal.

### Status

```bash
flockctl status
```

Reads the PID file, does a `kill -0` to verify the process is alive, and reports. A stale PID file (process gone) is cleaned up automatically.

## File layout

| Path | Purpose |
|------|---------|
| `~/flockctl/flockctl.db` | SQLite database (WAL mode — `flockctl.db-wal` and `flockctl.db-shm` sit next to it) |
| `~/flockctl/flockctl.pid` | Daemon PID |
| `~/flockctl/flockctl.log` | Daemon stdout / stderr (append) |
| `~/flockctl/workspaces/` | Project workspaces created by the UI |
| `~/flockctl/skills/` | Global skill files — safe to customize |
| `~/flockctl/mcp.json` | Global MCP server config (optional) |
| `~/.flockctlrc` | User config: tokens, model defaults, remote servers |

Override the data root with `FLOCKCTL_HOME=/custom/path` or `"home": "/custom/path"` in `~/.flockctlrc`. See [CONFIGURATION.md](CONFIGURATION.md).

## Health check

```bash
curl http://127.0.0.1:52077/health
# {"status":"ok","version":"1.0.0","hostname":"..."}
```

Public in every mode — never requires auth. Use for liveness probes.

## Logs

Daemon stdout / stderr is appended to `~/flockctl/flockctl.log`. There is no built-in log rotation; point `logrotate` at the file if the daemon runs for weeks.

Per-task logs live in the `task_logs` table and stream over `/ws/ui/tasks/:id/logs` — see [PROTOCOL.md](PROTOCOL.md).

## Backup

Flockctl state lives in two places:

```bash
# DB snapshot (atomic while daemon is paused)
flockctl stop
cp ~/flockctl/flockctl.db ~/flockctl/flockctl.db.backup
flockctl start

# Config (includes remote access tokens!)
cp ~/.flockctlrc ~/.flockctlrc.backup
```

**Treat `~/.flockctlrc` backups as secrets.** They carry every `remoteAccessTokens` entry and every configured provider key that sits there (keys in the DB are in plaintext too — see [SECURITY.md](SECURITY.md)).

For live backup of the WAL-mode DB without stopping the daemon, use `sqlite3 ~/flockctl/flockctl.db ".backup /path/to/copy.db"` — atomic and concurrent-safe.

## Running under a process supervisor

If you want the daemon to come back after a reboot, point a process supervisor at `node dist/cli.js start` (foreground equivalent) or re-invoke `flockctl start` on boot.

### launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.flockctl.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                 <string>com.flockctl.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/flockctl/dist/cli.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>             <true/>
  <key>KeepAlive</key>             <true/>
  <key>StandardOutPath</key>       <string>/Users/you/flockctl/flockctl.log</string>
  <key>StandardErrorPath</key>     <string>/Users/you/flockctl/flockctl.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.flockctl.daemon.plist
```

Note: `flockctl start` itself forks a detached child and exits. Under launchd you either (a) accept the double-fork and let launchd restart the parent (the child runs uninterrupted), or (b) run the server directly with `node /path/to/dist/server-entry.js` and let launchd own the single process.

### systemd (Linux)

```ini
# ~/.config/systemd/user/flockctl.service
[Unit]
Description=Flockctl daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/flockctl/dist/server-entry.js
Restart=on-failure
Environment=FLOCKCTL_HOME=%h/flockctl

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now flockctl
systemctl --user status flockctl
```

Pointing at `server-entry.js` directly (not `cli.js start`) lets systemd own the server process without the daemonization fork — cleaner restart semantics.

## Upgrading

```bash
flockctl stop
git pull
npm install
npm run build
flockctl start
```

Migrations run automatically on the next boot. `~/flockctl/` data and `~/.flockctlrc` are preserved across upgrades.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| `Flockctl failed to start (exit code 1)` | Security gate refused (see stderr) or port in use. Run `node dist/server-entry.js --port ...` directly to see the unredirected error |
| PID file exists but `status` says stopped | Stale PID; `flockctl status` or `flockctl stop` auto-cleans |
| Tasks stuck in `running` after restart | Step 5 of boot should re-queue them automatically. Check `~/flockctl/flockctl.log` for the reconciliation output |
| `[SECURITY WARNING]` every startup | Remote mode enabled via `--allow-insecure-public`. Generate a token with `flockctl token generate --label <name> --save` and restart without the flag |
| `~/.flockctlrc has permissions 644, expected 600` | `chmod 600 ~/.flockctlrc`. Flockctl re-applies this on every write, but the initial file follows your umask |
| Migrations fail on upgrade | The daemon logs the failing statement. The DB is in WAL mode — back up `flockctl.db`, `flockctl.db-wal`, and `flockctl.db-shm` together before trying a manual fix |

See [SECURITY.md](SECURITY.md) for the threat model and [REMOTE-ACCESS.md](REMOTE-ACCESS.md) for reverse-proxy / TLS setup.
