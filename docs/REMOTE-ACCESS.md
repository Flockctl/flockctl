# Remote access

Flockctl is **secure by default**: `flockctl start` binds only to `127.0.0.1` and needs no configuration. Remote access — reaching the daemon from another machine — is opt-in and requires two steps: **generate at least one token**, then **bind to a non-loopback interface**.

The server refuses to bind to a non-loopback host without a configured token, unless you explicitly pass `--allow-insecure-public` (break-glass; see below).

> **Scope.** Remote mode is designed for **personal** remote access — you reaching your own server from your own devices. It is single-tenant: every valid token has full API access. There are no user accounts, roles, or RBAC. For team scenarios, front the daemon with a reverse proxy that handles SSO.

## Quick setup

```bash
# 1. Generate a labeled token and save it to ~/.flockctlrc
flockctl token generate --label phone --save
# The full token is printed exactly once — copy it onto the device that will use it.

# 2. (Optional) Add CORS origins for your UI to ~/.flockctlrc:
#       "corsOrigins": ["https://flockctl.example.com"]

# 3. Restart the daemon on a non-loopback interface
flockctl stop
flockctl start --host 0.0.0.0
```

Startup log confirms auth is active:

```
Remote access enabled on http://0.0.0.0:52077 (token auth active)
```

## Per-device tokens

Generate one labeled token per device or use case:

```bash
flockctl token generate --label phone  --save
flockctl token generate --label laptop --save
flockctl token generate --label ci     --save

flockctl token list
# LABEL   FINGERPRINT
# phone   a1b2c3d4
# laptop  e5f6a7b8
# ci      99aabbcc

flockctl token revoke ci    # laptop + phone keep working
```

Matching is independent and timing-safe across all configured tokens; loss of one device's token does not force you to rotate the others.

## What the middleware enforces

Once at least one token is configured, `src/middleware/remote-auth.ts` applies the following to every request:

| Control | Behavior |
|---------|----------|
| **Localhost bypass** | If the socket's remote address is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`, the request passes without auth so the local UI keeps working |
| **Bearer header** | Non-local HTTP requests must send `Authorization: Bearer <token>`. Matched against every configured entry; missing/wrong → `401` + rate-limit hit |
| **Timing-safe compare** | Uses `crypto.timingSafeEqual` and iterates the full token list to defeat early-exit timing leaks |
| **Public paths** | `GET /health` and `OPTIONS` preflight always pass so probes and CORS work |
| **Rate limit** | 5 failed auth attempts per IP per 60 s → `429`. Counter resets on success or window expiry |
| **IP source** | Read from the Node socket, not from `X-Forwarded-For` / `Forwarded`. Header spoofing cannot forge "localhost" |
| **Minimum token length** | Tokens under 32 chars are rejected at load time with a `[SECURITY]` warning; the daemon behaves as if no token were set |
| **WebSocket auth** | Browser WebSocket API can't set headers, so non-local WS connections must include `?token=<token>` in the URL. Failure closes with code `1008` |
| **CORS** | Only origins in `corsOrigins` are allowed. Empty/absent list → wildcard (treat this as misconfiguration for remote mode) |
| **File permissions** | Startup warns if `~/.flockctlrc` isn't mode `600` while a token is active |

## Reverse proxy + TLS

Flockctl speaks plain HTTP. Put it behind a TLS-terminating reverse proxy pointing at `127.0.0.1:52077`.

**Caddy:**

```caddyfile
flockctl.example.com {
    reverse_proxy 127.0.0.1:52077
}
```

**nginx:**

```nginx
server {
    server_name flockctl.example.com;
    listen 443 ssl;
    # ... TLS setup ...

    location / {
        proxy_pass http://127.0.0.1:52077;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
    }
}
```

When using a reverse proxy, keep the daemon bound to `127.0.0.1` (the default) — the proxy on the same host is the only client that needs to reach it. You still need a token because the proxy forwards requests with a non-localhost remote address.

**Tailnet / VPN:** similar pattern — bind to the tailnet address (e.g. `flockctl start --host 100.x.y.z`) and rely on the network layer for access control on top of token auth.

## UI — registering remote daemons

The UI has a server switcher (sidebar). Each entry is persisted in `remoteServers` in `~/.flockctlrc` and managed through the API:

```bash
# Add
curl -X POST http://localhost:52077/meta/remote-servers \
  -H 'Content-Type: application/json' \
  -d '{ "name": "work-laptop", "url": "https://flockctl.example.com", "token": "<bearer>" }'

# List (tokens redacted → hasToken: true/false)
curl http://localhost:52077/meta/remote-servers

# Update (null clears the token)
curl -X PATCH http://localhost:52077/meta/remote-servers/<id> \
  -H 'Content-Type: application/json' \
  -d '{ "token": null }'

# Delete
curl -X DELETE http://localhost:52077/meta/remote-servers/<id>
```

The UI fetches the bearer token on demand via `/meta/remote-servers/:id/proxy-token` — tokens never round-trip through the list endpoint.

## Escape hatch — public bind without a token

```bash
flockctl start --host 0.0.0.0 --allow-insecure-public
```

This starts the daemon with **no authentication** on every reachable interface. Anyone who can connect can create tasks — meaning run Claude Code on your machine with your API keys. A `[SECURITY WARNING]` is printed on every startup and in the daemon log.

Use this only on a trusted VPN / tailnet segment that is already gated by something else (Tailscale ACLs, firewall, mesh network). For anything else, generate a token first.

## Operational checklist

- [ ] Token generated (`flockctl token generate --label <device> --save`)
- [ ] `~/.flockctlrc` has mode `600` (`ls -l ~/.flockctlrc`)
- [ ] `corsOrigins` set if you access the UI from a non-local origin
- [ ] Reverse proxy terminates TLS (Caddy / nginx / Cloudflare Tunnel / Tailscale Serve / …)
- [ ] Daemon bound to a non-loopback interface (`flockctl start --host 0.0.0.0` or tailnet IP)
- [ ] Startup log shows `Remote access enabled ... (token auth active)` — **not** `[SECURITY WARNING]`
- [ ] Test from a remote device: `curl -H 'Authorization: Bearer <token>' https://flockctl.example.com/health` → 200

See [SECURITY.md](SECURITY.md) for the threat model and [CONFIGURATION.md](CONFIGURATION.md) for the full `~/.flockctlrc` reference.
