---
name: security
description: Flockctl application-level security — labelled bearer tokens, localhost bypass, rate-limited auth failures, CORS whitelist, WebSocket `?token=` query param, startup bind-safety gate, and `~/.flockctlrc` 600 check. Use when adding or modifying auth, investigating 401/429, adding a new WebSocket endpoint, changing CORS, or handling API-provider keys. Keywords: auth, authentication, авторизация, bearer, token, токен, remote access, удалённый доступ, localhost, loopback, 401, 403, 429, rate limit, cors, websocket token, flockctlrc, chmod 600, secure default, single-tenant.
---

# Flockctl Auth & Security

## Threat Model in One Paragraph

Flockctl is **single-tenant, local-first**. The daemon binds to `127.0.0.1` by default and has no auth. The moment you need remote access, you generate one or more labelled bearer tokens and bind to a non-loopback interface. Every valid token has full API access — there are no user accounts, roles, or RBAC. If you want multi-user, front the daemon with a reverse proxy that handles SSO.

Flockctl does **not** use JWT, bcrypt, OAuth, PKCE, or password hashing. Do not reintroduce them — single-tenant bearer tokens are deliberate.

## Authentication Architecture

| Layer | Where | What |
|---|---|---|
| **Bind gate** | [src/lib/security-gate.ts](src/lib/security-gate.ts) → called from [src/server-entry.ts](src/server-entry.ts) | Refuses to bind a non-loopback host when no token is configured, unless `--allow-insecure-public` is passed |
| **HTTP auth** | [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts) — the `remoteAuth` middleware in [src/server.ts](src/server.ts) | Bearer check on every non-localhost request |
| **WebSocket auth** | `verifyWsToken(c)` from the same file, called from [src/routes/ws.ts](src/routes/ws.ts) before `upgradeWebSocket` | Token passed via `?token=<token>` query param (browsers can't set WS headers) |
| **CORS** | [src/server.ts](src/server.ts) — `getCorsAllowedOrigins()` | Wildcard when loopback-only; strict whitelist when remote auth is active |
| **`~/.flockctlrc` perms** | `checkRcPermissions()` in [src/config.ts](src/config.ts) — called at startup when auth is active | Warn if the file isn't mode 600 |

## How `remoteAuth` Decides

```ts
// src/middleware/remote-auth.ts (abbreviated)
export const remoteAuth = createMiddleware(async (c, next) => {
  if (!hasRemoteAuth()) return next();                       // no tokens configured → open
  if (isPublicPath(c.req.method, c.req.path)) return next(); // GET /health, OPTIONS
  const clientIp = getClientIp(c);
  if (isLocalhost(clientIp)) return next();                  // loopback bypass
  if (isRateLimited(clientIp))
    return c.json({ error: "Too many failed attempts. Try again later." }, 429);
  const authHeader = c.req.header("Authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const match = provided ? findMatchingToken(provided) : null;
  if (!match) { recordFailure(clientIp); return c.json({ error: "Unauthorized" }, 401); }
  c.set("authTokenLabel" as never, match.label as never);
  return next();
});
```

Important guarantees:

- **IP is read from the Node socket**, not from `X-Forwarded-For` / `Forwarded`. Header spoofing cannot forge "localhost".
- **Timing-safe compare** — `findMatchingToken` iterates every configured token with `crypto.timingSafeEqual` so token length / position leaks nothing.
- **Rate limit: 5 failed attempts per IP per 60 s** → 429; counter resets on success or window expiry. Don't disable this when adding routes.
- **Public paths are a tiny allowlist**: `GET /health`, `OPTIONS`. Add to `isPublicPath` only with strong justification.

When you add a route, **do not** add extra auth checks — let the middleware do its job.

## Token Storage

Tokens live in `~/.flockctlrc`:

```json
{
  "remoteAccess": {
    "tokens": [
      { "label": "phone",  "token": "<≥32 chars>" },
      { "label": "laptop", "token": "<≥32 chars>" }
    ]
  },
  "corsOrigins": ["https://flockctl.example.com"]
}
```

Rules:

- **Minimum token length 32.** Shorter tokens are rejected at load time with a `[SECURITY]` warning; the daemon behaves as if no token were set. Enforced by `findMatchingToken` in [src/config.ts](src/config.ts).
- **File mode 600.** At startup, if auth is active and the file isn't 600, `checkRcPermissions()` prints a `[SECURITY WARNING]`. Saving via the token API (`flockctl token generate --save`) always `chmod 600`s the file.
- **Never log the full token.** The `/meta/remote-servers` API returns only `hasToken: true/false`; the real value round-trips via a separate `/meta/remote-servers/:id/proxy-token` endpoint.

Generate tokens via CLI, not by hand:

```bash
flockctl token generate --label phone --save
flockctl token list        # label + fingerprint
flockctl token revoke ci
```

## WebSocket Auth

Browsers can't set `Authorization` headers on `new WebSocket(...)`. Non-local WS connections **must** include `?token=<token>`:

```ts
// src/routes/ws.ts — pattern
const check = verifyWsToken(c);
if (!check.ok) {
  return c.text(check.reason, 401); // or close code 1008 after upgrade
}
// …proceed with upgradeWebSocket
```

When adding a new WS route, always call `verifyWsToken(c)` before upgrading. Closing code for auth failures on live sockets is **1008**.

## Startup Bind Gate

[src/lib/security-gate.ts](src/lib/security-gate.ts)'s `evaluateBindSecurity({ host, port, hasToken, allowInsecurePublic })` runs in [src/server-entry.ts](src/server-entry.ts) **before** any DB or filesystem side effect. Outcomes:

| Host | Token configured? | `--allow-insecure-public`? | Result |
|---|---|---|---|
| `127.0.0.1` / `::1` / `localhost` | — | — | OK, no warning |
| `0.0.0.0` / tailnet IP | yes | — | OK; startup log: `Remote access enabled on … (token auth active)` |
| `0.0.0.0` / tailnet IP | no | no | `refuse` — daemon exits 1 before touching the DB |
| `0.0.0.0` / tailnet IP | no | yes | OK but `[SECURITY WARNING]` on every startup |

This is intentional — "no-token public bind" must be a break-glass, not an accident.

## CORS

[src/server.ts](src/server.ts) configures CORS dynamically:

```ts
app.use("/*", (c, next) => {
  if (!hasRemoteAuth()) return cors()(c, next);          // loopback → wildcard
  const allowed = getCorsAllowedOrigins();
  return cors({
    origin: allowed && allowed.length > 0 ? allowed : "*",
    credentials: false,
  })(c, next);
});
```

If remote auth is active and `corsOrigins` is empty, CORS is still `*` — the daemon treats that as misconfiguration (startup log warns). When you add cross-origin-sensitive features, verify `corsOrigins` in your docs update.

## AI Provider Keys

Keys live in `ai_provider_keys` ([src/db/schema.ts](src/db/schema.ts)) and are selected by [src/services/key-selection.ts](src/services/key-selection.ts). Invariants:

- **Priority + `disabledUntil` + `consecutiveErrors`** determine selection. Never route around `selectKeyForTask`.
- **`allowedKeyIds` / `deniedKeyIds`** on `projects` and `workspaces` scope which keys may serve a given task.
- **Never log raw key values.** The UI masks them; routes return `keyValue` only for edit views behind auth.
- `providerType` is one of: `anthropic`, `openai`, `google`, `mistral`, `claude_cli`, `codex_cli`. Adding a provider means updating `src/services/cost.ts` pricing **and** `key-selection.ts` seeding.

Keys are **not** linked to a user — in single-tenant mode, every valid token can read / use every key.

## Security Checklist

When reviewing code security:

- [ ] No new public path added to `isPublicPath` without justification
- [ ] No new route re-implements token comparison — goes through `remoteAuth`
- [ ] New WebSocket routes call `verifyWsToken(c)` before upgrading
- [ ] No hard-coded secret in source; tokens in `~/.flockctlrc`, API keys in the DB
- [ ] Request bodies validated with Zod before the DB touches them (prevents malformed payloads sneaking into free-form text columns)
- [ ] Drizzle query builders used — never string-interpolate user input into SQL
- [ ] API keys never logged; masked in all response shapes except explicit edit endpoints
- [ ] New CORS-sensitive flows documented alongside the `corsOrigins` list in [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)
- [ ] Startup logs still show `Remote access enabled ... (token auth active)`, not `[SECURITY WARNING]`

See [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md) and [docs/SECURITY.md](docs/SECURITY.md) for the operator-facing story.
