# Flockctl — Agent Rules (project-public layer)

This is the `project-public` layer of Flockctl's three-layer AGENTS.md
model — see [docs/AGENTS-LAYERING.md](docs/AGENTS-LAYERING.md) for how
it composes with the `user` and `workspace-public` layers at session
start. Rules below apply whenever any agent (Flockctl-hosted or not)
works on this codebase.

## Verification Rules

1. **Never say "it works" without testing yourself.** After any code change, climb the tier ladder appropriate to the change (see [docs/TESTING.md](docs/TESTING.md)):
   - **Always:** `npm run test:coverage` — Vitest unit/integration + v8 coverage thresholds (pretest runs `typecheck`)
   - **For a specific test file:** `npx vitest run src/__tests__/routes/tasks.test.ts`
   - **If the change affects API behavior:** write or update a test that exercises the endpoint before claiming done
   - **If you changed migrations or DB boot code:** `npm run test:smoke` — real `server-entry.ts` against a clean `FLOCKCTL_HOME` (catches missing `_journal.json` entries and unsplit multi-statement SQL)
   - **If you touched the UI:** `cd ui && npx tsc -b --noEmit` AND `npm run test:e2e` (Playwright). **E2E is a local-only tier** — it does NOT run in CI (119 specs × ~30 min, and the suite has pre-existing rot we don't want gating releases). Run it locally before any UI PR; the rest of the UI tier (typecheck + lint + build + unit tests) does run in CI.
   - **If you touched AI integration** (`ai-client.ts`, `agent-session.ts`, `claude-cli.ts`, `src/services/agents/`): run `FLOCKCTL_LIVE_TESTS=1 npm run test:live` locally before opening the PR
   - **If you touched `src/cli.ts` or anything under `src/cli-commands/`:** run `npm run test:cli-docker` — every `flockctl` subcommand against a real daemon inside a disposable container (requires a running Docker daemon; not part of the default `pretest` chain)
   - **Before any release tag (`vX.Y.Z` or `vX.Y.Z-rc.N`):** `npm run test:install-tarball` — `npm pack` → install into a fresh tmp project → boot the daemon from that project's cwd → assert `/health` = 200. The **only** tier that validates the actual npm artefact (dist/ + migrations/ + npm `files` allowlist) instead of the source tree. Catches cwd-relative path bugs, missing files in the allowlist, and `tsc`-only breakage. Costs ~1.5–3 min because it does a real `npm install`. CI runs this on every PR + tag push (the `install-tarball` job).

2. **No Docker.** Flockctl is a local CLI daemon — no containers, no rebuilds. The sole exception is [tests/cli-docker/](tests/cli-docker/), which uses Docker as a disposable isolation harness for the `test:cli-docker` tier; no runtime code ever runs in a container.

3. **Test from the local environment.** Start the daemon with `npm start`, verify via `curl http://localhost:52077/...`.
   - `npm start` expects built artifacts in `dist/` — fails if project was not built first.
   - For local verification during development, use `npm run dev` (tsx watch) instead of `npm start`.
   - API health check endpoint: `GET /health` on port `52077`.

## Pre-push / End-of-work Checks

4. **Before declaring work done — run the same gates CI runs, locally.** CI failures on `main` or release tags are wasted hours; catch them before pushing. As a final pass after any non-trivial change:
   - `npm audit --audit-level=moderate` (root) **and** `cd ui && npm audit --audit-level=moderate` — moderate-severity advisories are CI-blocking. If a transitive dep ships a fix, run `npm audit fix` and commit the lockfile bump.
   - `npm run lint` (root) **and** `npm run lint:ui` — the UI lint config relaxes most rules to warnings, but leaves a tight error tier. CI runs `eslint .` so any new error blocks the build.
   - `npm run typecheck && npm run typecheck:ui`
   - `npm test` — the default Vitest tier; covers unit + integration. Tier-specific suites (`test:smoke`, `test:e2e`, `test:live`, `test:cli-docker`) per Rule 1 above.
   - On release commits, also run `npm pack --dry-run` and confirm only `dist/`, `migrations/`, `CHANGELOG.md`, `LICENSE`, `README.md`, `package.json` ship. Anything else is noise.

5. **Watch what gets committed and shipped.** Two failure modes to guard against:
   - **Accidentally committed cruft** — agent-managed scratch files, IDE state, build caches, secret-bearing dotfiles. Before any commit, eyeball `git status` for surprises and confirm nothing in the staging area looks like local-only state. The root [`.gitignore`](.gitignore) already blocks the common offenders (`.gsd`, `.bg-shell/`, `.idea/`, `.vscode/`, `.env`, `dist/`, `coverage/`, `.eslintcache`, `.prettiercache`, `*.tsbuildinfo`, `*.tgz`, `node_modules/`, `.flockctl/import-backup/`, etc.) — if you find yourself wanting to commit something that *would* be ignored, ask why before working around it.
   - **Accidentally published cruft** — the npm `files` allowlist in [`package.json`](package.json) is the second line of defense (only `dist`, `migrations`, `CHANGELOG.md`, `README.md`, `LICENSE` ship). Don't broaden it without an explicit reason. Run `npm pack --dry-run` on release commits and verify the file count + size haven't drifted.

## Platform Support

6. **Windows is not supported.** Flockctl targets macOS and Linux only. Do not add Windows-specific code paths, do not guard against Windows edge cases (path separators, `.exe` suffixes, CRLF line endings, OpenSSH-on-Windows quirks, etc.), and do not add Windows to CI matrices. If a Windows user reports a bug, the answer is "use WSL or macOS/Linux." This keeps the codebase smaller and the test surface tractable.

## Release & Publishing

7. **Never run `npm publish` (or `npm login`, or `npm dist-tag …`) manually.** Publishing to npm is fully automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which fires on every published GitHub Release (and supports `workflow_dispatch` with a `--dry-run` toggle). The workflow:
   - verifies the release tag (`vX.Y.Z`) matches `package.json` version,
   - verifies `CHANGELOG.md` has a `## [X.Y.Z]` entry,
   - runs typecheck + tests,
   - auto-picks the dist-tag (`next` for prerelease versions containing `-`, `latest` for stable),
   - publishes with npm provenance.

   The agent's release responsibilities end at: bump version in `package.json` + `package-lock.json`, update `CHANGELOG.md`, commit, tag `vX.Y.Z`, push the branch and the tag. Cutting the GitHub Release (which triggers publishing) is a human action — do not call the GitHub Releases API to create one without an explicit ask. If a previously-published version needs to be re-promoted (e.g. `next` → `latest`), do it via the workflow's `workflow_dispatch` input, not via local `npm dist-tag`.
