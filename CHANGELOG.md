# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
### Changed
### Fixed
### Removed

## [0.0.1-rc.1] - 2026-04-20

### Added
- Initial release candidate of Flockctl — local-first control plane for AI coding agents.
- Hono-based HTTP/SSE/WebSocket daemon with SQLite (WAL) persistence.
- Workspaces, projects, planning (milestones → slices → tasks), auto-executor.
- Chats with permission gating and resumable sessions.
- Templates, cron schedules, per-project skills and MCP servers.
- Per-row enable/disable toggle for own workspace and project skills.
- Cost and usage metrics per project / model / key.
- Multi-backend UI: one local UI can connect to many local or remote daemons via server switcher.
- Labelled bearer-token auth with timing-safe comparison and rate-limited failures.
- Settings → Defaults for global default AI model and default Provider Key (persisted in `~/.flockctlrc`).
- `PATCH /meta/defaults` endpoint and `defaults.keyId` field in `GET /meta`.
- Project scanning and import actions.
- Web UI bundled into the published npm package and served by the daemon.

[Unreleased]: https://github.com/Flockctl/flockctl/compare/v0.0.1-rc.1...HEAD
[0.0.1-rc.1]: https://github.com/Flockctl/flockctl/releases/tag/v0.0.1-rc.1
