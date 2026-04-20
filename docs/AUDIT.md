# Flockctl — Audit Notes

> **Last full audit:** 17 April 2026 — see [../audit/DEEP-AUDIT-2026-04-17.md](../audit/DEEP-AUDIT-2026-04-17.md) for the full report.
> **Scope:** Backend (src/), Frontend (ui/), Tests, Positioning, Documentation.

## Summary

| Area | Status | Notes |
|------|--------|-------|
| **Architecture** | ✅ Solid | TypeScript/Hono/SQLite, clean separation |
| **Security** | ⚠️ Conditional | Local mode fine as-is; remote mode adds Bearer token + CORS + rate limit — review `~/.flockctlrc` permissions on any host that has a token set |
| **Code Quality** | ✅ Good | Consistent patterns, typed schema |
| **Tests** | ✅ Passing | Vitest + smoke + Playwright; live tier local-only |
| **Documentation** | ✅ Up to date | Rewrite completed 17 April 2026 to reflect dual local/remote mode |
| **Positioning** | 🔁 In transition | README and docs now describe *both* the default local posture and the optional remote mode rather than claiming "local only" |

## Notes

- No Docker, no remote task workers — tasks run inside the daemon process.
- The product supports two operating modes that share a single binary:
  - **Local** (default): loopback only, no authentication, wildcard CORS.
  - **Remote** (opt-in): Bearer token in `~/.flockctlrc`, timing-safe compare, 5-fail-per-60s per-IP rate limit, CORS whitelist, WebSocket auth via `?token=...` query param.
- Database: SQLite with WAL mode, 11 tables.
- See [SECURITY.md](SECURITY.md) for the current threat model and [DEEP-AUDIT-2026-04-17.md](../audit/DEEP-AUDIT-2026-04-17.md) for the full analysis.
