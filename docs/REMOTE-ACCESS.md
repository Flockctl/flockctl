# Remote access

Flockctl daemons bind to `127.0.0.1` only. Remote access means reaching a Flockctl daemon running on another machine from your local Flockctl client. The transport is **SSH port-forwarding**, not a public HTTP bind. The remote daemon never opens a socket off loopback; the local daemon owns the tunnel lifecycle.

> **Scope.** Remote access is for personal multi-machine setups — your laptop reaching a daemon on your workstation or home server. Every configured remote inherits full API access via a bootstrap-minted bearer token. No accounts, no RBAC. Team deployments are out of scope.

## 1. How it works

```
┌──────────────────┐  SSH -L  ┌──────────────────┐
│ local flockctl   │─────────▶│ remote flockctl  │
│ 127.0.0.1:52077  │          │ 127.0.0.1:52077  │
│  (your client)   │          │   (the target)   │
└────────┬─────────┘          └──────────────────┘
         │ forwards
         ▼
 127.0.0.1:<tunnelPort>  ← what the UI/API talk to
```

- The local daemon spawns `ssh -N -L 127.0.0.1:<tunnelPort>:127.0.0.1:52077 user@host` per remote. The local port is kernel-allocated.
- The remote daemon keeps its default loopback bind. No firewall rule on the remote is required beyond SSH (22).
- A bootstrap step runs `flockctl remote-bootstrap --print-token --label <label>` over SSH on the remote to mint a bearer token; that token is stored in the local `~/.flockctlrc` and attached to every request the UI makes through the tunnel.
- Tunnels are stored in `~/.flockctlrc` under `remoteServers[]` and autostarted on every local-daemon boot.

SSH flags in use (see [src/services/ssh-tunnels/build-args.ts](../src/services/ssh-tunnels/build-args.ts)):

```
-N
-o ExitOnForwardFailure=yes
-o ServerAliveInterval=30
-o ServerAliveCountMax=3
-o StrictHostKeyChecking=accept-new
-o BatchMode=yes
-L 127.0.0.1:<lport>:127.0.0.1:<rport>
```

`BatchMode=yes` means SSH never prompts. Authentication must succeed non-interactively — use `ssh-agent`, an `identityFile` in the remote config, or key entries in `~/.ssh/config`.

## 2. Remote host prerequisites

On the remote host:

1. SSH listening (port 22 by default).
2. A user account whose `authorized_keys` contains your client's public key.
3. `flockctl` on `PATH` for that user's non-interactive login shell. Verify with:
   ```bash
   ssh user@host 'flockctl --version'
   ```
   If this prints `command not found`, fix `PATH` in the login shell (e.g. `~/.bashrc` / `~/.zshenv`) before adding the server to the client. Most `remote_flockctl_missing` errors are a login-shell `PATH` issue, not a missing install.
4. The remote daemon running (`flockctl start`). The bootstrap step does not start it for you.
5. `~/.flockctlrc` writable by that user (mode `600`). The bootstrap appends a token entry to `remoteAccessTokens[]` — one per client machine, labelled `flockctl-local-<your-hostname>`.

## 3. Adding a remote server

The client side is driven through the UI (sidebar server switcher) or directly through the loopback API on the local daemon. Both paths hit the same handler.

```bash
# From the client machine — talks only to the LOCAL daemon.
curl -X POST http://127.0.0.1:52077/meta/remote-servers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "workstation",
    "ssh": {
      "host": "workstation.lan",
      "user": "alice",
      "identityFile": "/Users/alice/.ssh/id_ed25519"
    }
  }'
```

Accepted fields under `ssh`:

| Field | Default | Notes |
|---|---|---|
| `host` | required | hostname, IPv4, `user@host`, or a `~/.ssh/config` alias. ASCII only; shell metacharacters rejected |
| `user` | — | username override; omit to use the one baked into `host` or `~/.ssh/config` |
| `port` | `22` | remote SSH port |
| `identityFile` | — | absolute path to a private key. Omit to use `ssh-agent` / `IdentityFile` from `~/.ssh/config` |
| `remotePort` | `52077` | port of the remote Flockctl daemon |

The `POST /meta/remote-servers` handler is gated by `requireLoopback` — a holder of some *other* remote's bearer cannot use it to register a new remote. Only the client machine's local UI / CLI can.

End-to-end on success:

1. Validate payload (Zod). Unknown top-level keys, missing `ssh`, legacy `url`/`token` → 400.
2. Allocate `id = randomUUID()`, `label = flockctl-local-<hostname>`.
3. `ssh user@host flockctl remote-bootstrap --print-token --label <label>` with a 10 s timeout.
4. Validate stdout matches `[A-Za-z0-9_-]{20,}` (rejects banners, progress, shell noise).
5. Write `{id, name, ssh, token, tokenLabel}` to `~/.flockctlrc` in a single 0o600 rewrite.
6. Spawn `ssh -N -L …`, wait up to 10 s for `GET http://127.0.0.1:<tunnelPort>/health` to return 2xx.
7. Respond `201 { id, name, ssh, tunnelPort, tunnelStatus: "ready" }`. The token is never echoed.

On failure at step 3, 4, or 6 the rc entry is rolled back and the response carries a stable `errorCode` — see [Troubleshooting](#5-troubleshooting). On step 5 failure the response is `500 persistence_failed` and nothing is written.

Pre-SSH entries (`{url, token}`) in `~/.flockctlrc` are purged on daemon boot by `purgeLegacyRemoteServers` and a `[flockctl] Removed N legacy remote server(s) …` line is logged. Re-add them through the UI.

## 4. Operating tunnels

Every endpoint below is on the **local loopback daemon**, gated by `requireLoopback`. Paths are under `/meta/remote-servers/:id/`.

```bash
# List servers — each entry enriched with live tunnel state.
curl http://127.0.0.1:52077/meta/remote-servers
# → [{ id, name, ssh, tunnelStatus, tunnelPort, tunnelLastError, errorCode }, …]

# Status of a single tunnel
curl http://127.0.0.1:52077/meta/remote-servers/<id>/tunnel/status

# Start / stop / restart
curl -X POST http://127.0.0.1:52077/meta/remote-servers/<id>/tunnel/start
curl -X POST http://127.0.0.1:52077/meta/remote-servers/<id>/tunnel/stop
curl -X POST http://127.0.0.1:52077/meta/remote-servers/<id>/tunnel/restart

# Patch name / ssh config — handler restarts the tunnel iff any ssh.* field changed
curl -X PATCH http://127.0.0.1:52077/meta/remote-servers/<id> \
  -H 'Content-Type: application/json' \
  -d '{ "ssh": { "user": "bob" } }'

# Delete — stops the tunnel and removes the rc entry
curl -X DELETE http://127.0.0.1:52077/meta/remote-servers/<id>

# Fetch the bearer token for the tunnel (local UI uses this when it needs
# to proxy requests through the forwarded port). Tokens never appear in
# list / status responses.
curl -X POST http://127.0.0.1:52077/meta/remote-servers/<id>/proxy-token
```

`tunnelStatus` values: `starting`, `ready`, `error`, `stopped`.

Once `tunnelStatus === "ready"`, anything the local UI wants to send to the remote goes to `http://127.0.0.1:<tunnelPort>/…` — that's the forwarded port, not the remote's SSH port. Example:

```bash
# Hit the remote daemon's /health via the tunnel
TOKEN=$(curl -sX POST http://127.0.0.1:52077/meta/remote-servers/<id>/proxy-token | jq -r .token)
PORT=$(curl -s http://127.0.0.1:52077/meta/remote-servers/<id>/tunnel/status | jq -r .tunnelPort)
curl http://127.0.0.1:$PORT/health
# Remote API call:
curl -H "X-Flockctl-Token: $TOKEN" http://127.0.0.1:$PORT/meta
```

### Autostart, reconnect, shutdown

- On local-daemon boot, `server-entry.ts` iterates every `remoteServers[]` entry and fires `manager.start(server)` concurrently via `Promise.allSettled`. `/health` stays responsive during the fan-out; tunnel readiness lags by the ready-gate budget.
- The tunnel manager reconnects on non-terminal failures with exponential backoff `1s → 2s → 4s → 8s → 30s`, reset on `ready`.
- Terminal failures (`host_key_mismatch`, `remote_flockctl_missing`) do **not** auto-reconnect — they require user action. `/tunnel/restart` retries after you've fixed the cause.
- On graceful daemon stop, every child `ssh` process is sent SIGTERM (3 s grace) and then SIGKILL (1 s grace). Total shutdown fits in the 15 s daemon budget.

## 5. Troubleshooting

Every error below surfaces on the HTTP response as `{ errorCode, error, … }` and is mapped to the same English string in [ui/src/locales/en.json](../ui/src/locales/en.json) for UI display. `rawStderr` (last ~2 KB of the SSH child's stderr, ANSI-stripped) is included where the manager captured output.

| `errorCode` | What happened | Fix | If that doesn't work |
|---|---|---|---|
| `invalid_ssh_config` | Zod rejected the `ssh` block — missing `host`, disallowed chars, unknown top-level key, out-of-range port, or the argv builder found a bad `identityFile` / `user`. | Re-check the payload against [§3](#3-adding-a-remote-server). Host must match `^[A-Za-z0-9_.\-@:]+$`; user must match `^[A-Za-z0-9_.\-]+$`; paths must be absolute and non-empty. | Try the exact `ssh user@host` line by hand. If that works, diff your payload against the CLI you just ran. |
| `legacy_transport_rejected` | The request body carries top-level `url` or `token` — the pre-SSH remote-server shape. | Drop `url` / `token`; supply `ssh: { host, … }` instead. | Remove the stale entry from `~/.flockctlrc` (boot purges it automatically) and re-add via the UI. |
| `auth_failed` | SSH replied `Permission denied` — key not in `authorized_keys`, wrong username, agent not forwarding, or `identityFile` unreadable / wrong key. | `ssh -v -i <identityFile> user@host` and fix whatever `debug1: Offering public key` / `no such identity` shows. Confirm the public key is on the remote: `ssh user@host 'grep $(awk "{print \$2}" <pubkey>) ~/.ssh/authorized_keys'`. | Check the remote `sshd` allows pubkey (`PubkeyAuthentication yes`) and isn't rate-limiting (`/var/log/auth.log` or `journalctl -u ssh`). |
| `host_key_mismatch` | Remote host key doesn't match `~/.ssh/known_hosts`. Either the remote was reinstalled / rekeyed, or something is sitting between you and it. Tunnel will **not** auto-reconnect. | Verify out-of-band that the remote is really yours. Then `ssh-keygen -R <host>` and reconnect — `StrictHostKeyChecking=accept-new` will record the new key on first use. | If the key is wrong: stop and investigate. Do not blindly remove the old entry. |
| `connect_refused` | TCP reach to the remote failed — `Connection refused`, `Name or service not known`, or `Could not resolve hostname`. sshd never answered. | Confirm `host` resolves (`dig`, `getent hosts`), the remote is reachable (`ping`), and sshd is listening on the expected port (`ss -tlnp \| grep sshd` on the remote). Fix the `port` field if sshd isn't on 22. | If the host is on a VPN / tailnet, confirm the interface is up. Firewalls on the path (your ISP, a corporate gateway) will also surface here. |
| `remote_flockctl_missing` | Remote shell executed but `flockctl` wasn't on `PATH` — either not installed or login-shell `PATH` doesn't include it. Tunnel will **not** auto-reconnect. | `ssh user@host 'command -v flockctl'`. If empty, install flockctl globally (`npm install -g flockctl@next`) or add its directory to the remote's `~/.bashrc` / `~/.zshenv` (not `~/.bashrc`-for-interactive-only). | Use a wrapper script on a stable path (`/usr/local/bin/flockctl`) symlinked to the real binary — survives `nvm`-switched Node versions. |
| `remote_daemon_down` | SSH + exec succeeded, but the tunnel's `channel N: open failed: connect failed` — meaning sshd reached `127.0.0.1:<remotePort>` on the remote and nothing was listening. | `ssh user@host 'flockctl start'`, then restart the tunnel: `POST /meta/remote-servers/<id>/tunnel/restart`. | Verify the remote daemon is on the expected port: `ssh user@host 'curl -s http://127.0.0.1:52077/health'`. If the daemon is on a non-default port, update `ssh.remotePort` via PATCH. |
| `bootstrap_bad_output` | `flockctl remote-bootstrap --print-token` ran but stdout wasn't a clean base64url token — usually an older flockctl that writes banners/progress to stdout, or a shell init file (`~/.bashrc`) that prints on every SSH login. | Upgrade the remote flockctl (`npm install -g flockctl@next`). Silence shell-init noise for non-interactive sessions (`[[ $- == *i* ]] \|\| return` at the top of `~/.bashrc`). | Reproduce manually: `ssh user@host 'flockctl remote-bootstrap --print-token --label test'` should print exactly one 43-char base64url token and nothing else. |
| `tunnel_open_timeout` | SSH spawned and didn't error, but the ready-gate (`GET http://127.0.0.1:<lport>/health` every 200 ms for 10 s) never got a 2xx. | Retry via `POST /tunnel/restart` — transient network loss is common. Check `tunnelLastError` (response field) and `journalctl`/daemon logs for the ssh stderr tail. | On very slow links, the 10 s budget can be tight. Confirm the remote daemon is up *and* responsive: `ssh user@host 'curl -sS --max-time 5 http://127.0.0.1:52077/health'`. |
| `persistence_failed` | `saveRc(~/.flockctlrc)` threw after the bootstrap succeeded — disk full, `EACCES`, rc mode tightened to `400`, or the home directory is unwritable. | `ls -l ~/.flockctlrc`; chown / chmod 600 back to your user. Ensure `$HOME` has free space. | The remote now has a stranded token entry under label `flockctl-local-<hostname>`. Clear it with `ssh user@host 'flockctl token revoke flockctl-local-<hostname>'` before retrying, otherwise it piles up. |
| `unknown` | SSH exited non-zero and stderr didn't match any pattern in [classify-stderr.ts](../src/services/ssh-tunnels/classify-stderr.ts). | Read `rawStderr` on the tunnel handle (UI: server detail panel; API: `GET /tunnel/status`). | Reproduce with `ssh -v` on the same command-line flockctl used (`-N -o BatchMode=yes -L 127.0.0.1:<lport>:127.0.0.1:52077 user@host`) and inspect the verbose output. File an issue if the stderr looks like it *should* have matched a classifier pattern. |

## Operational checklist

- [ ] `ssh user@host 'flockctl --version'` prints a version (no `command not found`).
- [ ] `ssh user@host 'flockctl start'` leaves a daemon running (`curl -s http://127.0.0.1:52077/health` over ssh returns 200).
- [ ] `~/.flockctlrc` is mode `600` on both machines.
- [ ] Server added via UI / POST; `tunnelStatus` reads `ready` within ~10 s.
- [ ] `curl http://127.0.0.1:<tunnelPort>/health` on the client returns 200 through the tunnel.

See [SECURITY.md](SECURITY.md) for the threat model and [CONFIGURATION.md](CONFIGURATION.md) for the full `~/.flockctlrc` reference.
