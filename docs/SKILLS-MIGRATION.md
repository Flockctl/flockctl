# Skills & MCP Architecture Migration Plan

> **Status: Implemented (2026-04-18).** All phases landed in a single commit. The document below is preserved as the historical design record. `tasks.disabled_skills` and `tasks.disabled_mcp_servers` have been dropped (migration 0023). `.flockctl/config.json` is the canonical spec; `.claude/skills/` and `.mcp.json` are reconciled generated views.

## Why

The skills system and the MCP server system have grown almost-identical architectures with the same two problems. We fix both in one migration — the reconciler pattern is shared, and the YAML→JSON config rewrite touches both `disabledSkills` and `disabledMcpServers`.

**Skills:**
1. **Skills are inlined into every system prompt** as `<skills>` XML blocks in [src/services/agent-session.ts:455-460](../src/services/agent-session.ts#L455-L460). Claude Code has native progressive disclosure — only skill name + description auto-load; full `SKILL.md` loads on demand via the Skill tool. Inline injection wastes tens of thousands of tokens per task.
2. **Task-level `disabledSkills` lives in DB** ([src/db/schema.ts:74](../src/db/schema.ts#L74)). Workspace and project levels already migrated to YAML (migrations 0018/0019). The DB column is the last piece of non-YAML disable state.

**MCP (same problems, mirror structure — [src/services/mcp.ts](../src/services/mcp.ts)):**
1. **MCP servers are inlined into every system prompt** as `<available_mcp_servers>` XML blocks at [src/services/agent-session.ts:462-472](../src/services/agent-session.ts#L462-L472). Claude Code discovers MCP servers natively via `.mcp.json` (project-level) — the XML is dead weight the model ignores.
2. **Task-level `disabledMcpServers` lives in DB** ([src/db/schema.ts](../src/db/schema.ts)). Same anti-pattern as `disabledSkills`; drop it.

## Target state

- Swarmctl **config files** (`.flockctl/config.yaml`) migrate to **JSON**. The `yaml` npm package stays — it's still needed for YAML frontmatter in `SKILL.md` and plan markdown files (Claude Code's native skill format mandates YAML frontmatter; see [src/services/plan-store.ts:99-119](../src/services/plan-store.ts#L99-L119)).

**Skills:**
- **Reconciler is the single mechanism** for exposing skills to Claude Code. Symlink reconciliation at **both** levels: `<workspace>/.claude/skills/` (global + workspace, minus workspace-scoped `disabledSkills[]` entries whose `level` targets `global` or `workspace`) and `<project>/.claude/skills/` (global + workspace + project, minus both workspace- and project-scoped disable entries, each matched by `(name, level)` pair). Claude Code's native loader picks up whichever set matches its cwd.
- **`seedClaudeCodePlugin` is removed** ([src/config.ts:350](../src/config.ts#L350)). The plugin mechanism can't express project-scoped disables — a global skill exposed as a plugin can't be hidden from a specific project. Dropping it eliminates the duplication risk and makes the reconciler the single source of truth. `~/.claude/settings.json` mutations (`extraKnownMarketplaces`, `enabledPlugins`) also go away; existing entries get cleaned up on first boot.
- **`skills-state.json` manifests** at both workspace and project level are the committed declarative source of truth for "what Swarmctl resolved as the effective skill set and at which level each skill came from." Teammates clone → they see identical skills-state → their local reconciler produces identical `.claude/skills/`. UI reads these instead of re-resolving.
- `reconciled_at` timestamp lives in `.flockctl/.skills-reconcile` (gitignored) — **not** in the committed manifest. This keeps the committed file byte-stable across reconciles when content is unchanged, avoiding git noise.
- No more `<skills>` XML injection in task/chat system prompts.
- Task-level disable feature **removed entirely** — every task uses the full currently-enabled set.
- `tasks.disabled_skills` DB column dropped.
- `Skill` tool added to `READ_ONLY_TOOLS` allowlist so auto-permission-mode doesn't prompt the user for every on-demand skill load.
- `.flockctl/skills/`, `.flockctl/config.json`, `.flockctl/skills-state.json` are **committed** to git at both workspace and project levels. `.claude/skills/` and `.flockctl/.skills-reconcile` are **gitignored** at both levels and produced locally per teammate.

**MCP (parallel to skills):**
- **Reconciler writes merged `.mcp.json`** at both levels: `<workspace>/.mcp.json` and `<project>/.mcp.json`. Not symlinks — Claude Code expects a single merged JSON file with `mcpServers` key. Reconciler writes effective MCP set (global + workspace + project, minus disables) with deterministic key ordering, 2-space indent, trailing newline → byte-stable.
- **Global MCP servers are copied into each project/workspace `.mcp.json`** (Option A). Reconciler never mutates `~/.claude.json`. Per-project self-containment + project-scoped disables work correctly. Duplication on disk is acceptable (file is small, generated, gitignored).
- **`mcp-state.json` manifests** at both workspace and project level — same role as `skills-state.json`: committed shared state `{mcpServers: [{name, level}]}`, byte-stable.
- `.flockctl/.mcp-reconcile` (gitignored) holds the local timestamp.
- No more `<available_mcp_servers>` XML injection in task/chat system prompts.
- Task-level disable feature **removed entirely**. `tasks.disabled_mcp_servers` DB column dropped.
- `disabledMcpServers` in `config.json` becomes `[{name, level}]` (same shape as `disabledSkills`).
- `.flockctl/mcp/`, `.flockctl/config.json`, `.flockctl/mcp-state.json` are **committed**. `.mcp.json` and `.flockctl/.mcp-reconcile` are **gitignored**.

## Decisions (locked)

1. **Task-level disable: DROP the feature.** No DB column, no in-memory overlay, no per-task API. Each task runs with the full enabled set. Simplifies reconciler (no task overlay), eliminates per-project concurrency lock requirement.
2. **`plan-prompt.ts` drops all inline injection.** Correction of earlier decision: plan generation IS already a Claude Code session (task-executor runs the plan-gen task with `agent: "claude-code"` at [src/routes/planning.ts:277-289](../src/routes/planning.ts#L277-L289)). So native skill loading works. Remove both (a) project-skill XML blocks and (b) `planning`-skill template reading (`planStructure`, `modeSection`). The new prompt passes an **explicit mode directive** (e.g. `Use the planning skill's "Quick Mode" section`) so the model loads the right skill section on demand. Reconciler guarantees `planning` skill is present via symlinks before task-executor starts the task. Delete `stripFrontmatter`, `loadPlanningSkill`, `extractModeSection`, `extractPlanStructure`, `resolveSkillsForProject` call, and unused imports.
3. **Claude Code only.** No non-CC provider support, no `skillDelivery` discriminator. Remove inline injection path outright in agent-session.ts.
4. **Only config files migrate to JSON.** Migrate `config.yaml` → `config.json` at workspace and project level inline with this work. No YAML-reading fallback, no deprecation window (Swarmctl is pre-release — see memory `project_swarmctl_prerelease`). One-shot boot-time conversion converts any existing local `config.yaml` to `config.json` and deletes the YAML file. **`yaml` npm package stays** — plan markdown files and `SKILL.md` use YAML frontmatter (mandated by Claude Code format); [plan-store.ts](../src/services/plan-store.ts) keeps using it.
5. **`skills-state.json` is committed but byte-stable across no-op reconciles.** Lives at `<workspace>/.flockctl/skills-state.json` and `<project>/.flockctl/skills-state.json`. Shared via git so teammates see same reconciled intent and disables. `reconciled_at` is **not** in this file — it lives in `.flockctl/.skills-reconcile` (gitignored). This way re-running the reconciler on unchanged state produces zero git diff.
6. **Manifest at both workspace and project level.** Workspace `skills-state.json` captures workspace-effective view (global + workspace, minus disables). Project `skills-state.json` captures project-effective view (global + workspace + project, minus disables). Symmetry simplifies UI listing and testing.
7. **Reconciler is the only delivery mechanism.** `seedClaudeCodePlugin` is removed along with the `~/flockctl/.claude-plugin/` directory and `~/.claude/settings.json` entries. Global skills reach Claude Code via the same symlink reconciliation path as workspace and project skills. Cleanup pass on first boot after upgrade removes the plugin artifacts.
8. **`Skill` tool is read-only.** Add to `READ_ONLY_TOOLS` in [permission-resolver.ts](../src/services/permission-resolver.ts#L105) so `auto` permission mode does not prompt the user for every on-demand skill load. (In `default` mode Swarmctl still prompts — that's the mode's semantic; users who chose it accept per-tool prompts including Skill.)
9. **`POST /tasks` with `disabledSkills` in body → strict 400.** Pre-release, no backcompat; reject unknown/removed fields explicitly rather than silently ignore.
10. **Chat tool events are persisted.** Task logs already persist `tool_call`/`tool_result` rows; chats currently stream them live-only. For parity and to survive refresh, add chat tool events to `chat_messages` via new role `"tool"` + structured content (see Phase 4.5 for schema).
11. **`disabledSkills` entries are `{name, level}` objects.** Current shape `string[]` can't distinguish "disable the global `bugfix`" from "disable the workspace-level `bugfix` override". New shape in `config.json`:
    ```json
    {
      "disabledSkills": [
        { "name": "bugfix", "level": "global" },
        { "name": "old-helper", "level": "workspace" }
      ]
    }
    ```
    `level` ∈ `"global" | "workspace" | "project"`. A disable entry must target a scope that's visible at the config file's own level: workspace `config.json` can target `global`/`workspace`; project `config.json` can target any of the three. The reconciler's precedence rules still apply — if `bugfix` is disabled at level `global` but the workspace has its own `bugfix` skill, the workspace skill stays effective. This matches the three-tier override model. UI becomes `(name, level)` checkbox pairs instead of flat name list.
12. **MCP gets the full parallel architecture.** Every skills decision above applies to MCP with these concrete mappings:
    - Source of truth: `.flockctl/mcp/<name>.json` (existing layout).
    - Claude Code destination: `<project>/.mcp.json` and `<workspace>/.mcp.json` (generated, gitignored, merged, byte-stable).
    - Global MCP path: **Option A — copy into each `.mcp.json`**. Reconciler does **not** write to `~/.claude.json`. Rationale: project-scoped disables require per-project control; global registration would break them exactly like the plugin did for skills (see Phase 0.5 reasoning).
    - `disabledMcpServers` takes the same `[{name, level}]` shape.
    - `tasks.disabled_mcp_servers` dropped alongside `tasks.disabled_skills`.
    - No `<available_mcp_servers>` injection in system prompts — Claude Code discovers MCP natively from the written `.mcp.json`.
    - `resolveMcpServersForTask` deleted alongside `resolveSkillsForTask`.
    - UI route changes mirror skills: `POST/DELETE /workspaces/:id/disabled-mcp` and `/projects/:pid/disabled-mcp` become body-based with `{name, level}`.

## Affected files (from codebase map)

### Remove prompt injection
- [src/services/agent-session.ts:455-460](../src/services/agent-session.ts#L455-L460) — drop `<skills>` XML block
- [src/services/agent-session.ts:25-46](../src/services/agent-session.ts#L25-L46) — `AgentSessionOptions.skills` field: remove
- [src/services/task-executor.ts:159,240](../src/services/task-executor.ts#L159) — stop calling `resolveSkillsForTask`, call reconciler instead
- [src/routes/chats.ts:331](../src/routes/chats.ts#L331) — remove `skills: []` line, call reconciler if chat is project-scoped

### plan-prompt refactor
- [src/services/plan-prompt.ts](../src/services/plan-prompt.ts) — strip all inline injection; emit explicit mode directive (`Quick Mode`/`Deep Mode`) that names the `planning` skill. Delete `loadPlanningSkill`, `extractModeSection`, `extractPlanStructure`, `stripFrontmatter`.

### Reconciler (new)
- `src/services/claude-skills-sync.ts` — new file
- Called from: [src/server-entry.ts](../src/server-entry.ts) (startup), workspaces config save, projects config save, skills disable toggle routes, project creation, task-executor (before session start, but without task overlay)

### Drop `tasks.disabled_skills` column
- Schema: [src/db/schema.ts:74](../src/db/schema.ts#L74)
- New migration: `migrations/0023_drop_task_disabled_skills.sql`
- `migrations/meta/_journal.json` + test helper mirror `[src/__tests__/helpers.ts:152](../src/__tests__/helpers.ts#L152)`
- Reads: [src/services/skills.ts:138](../src/services/skills.ts#L138), [src/routes/skills.ts:266,279](../src/routes/skills.ts#L266), [src/routes/tasks.ts:234](../src/routes/tasks.ts#L234), [src/services/task-executor.ts:393](../src/services/task-executor.ts#L393)
- Writes: [src/routes/tasks.ts:158](../src/routes/tasks.ts#L158), [src/routes/skills.ts:267,280](../src/routes/skills.ts#L267)
- Task disable routes to DELETE: POST/DELETE [src/routes/skills.ts:260-285](../src/routes/skills.ts#L260-L285)
- `resolveSkillsForTask` function → delete ([src/services/skills.ts:131-143](../src/services/skills.ts#L131-L143))

### Gitignore + sharing
- Reconciler's `ensureGitignore` appends `.claude/skills/` on project creation
- Docs section in `docs/` (this file + update to relevant existing doc)

### Tests
- `src/__tests__/services/skills.test.ts` — keep `resolveSkillsForProject` tests; drop anything task-level
- New: `src/__tests__/services/claude-skills-sync.test.ts`
- `src/__tests__/routes/skills-extra.test.ts:179-217` — delete task-disable sections
- `src/__tests__/routes/tasks-extra.test.ts:57-71` — drop `disabledSkills` assertions from task creation test
- `src/__tests__/services/agent-session*.test.ts` — remove `<skills>` block assertions
- `src/__tests__/services/task-executor*.test.ts` — drop `resolveSkillsForTask` mock

---

## Phase-by-phase

### Phase 0 — Config format migration: YAML → JSON

This runs first so subsequent phases speak the new format natively.

1. **`src/services/workspace-config.ts`**:
   - Replace `parseYaml`/`stringifyYaml` imports with `JSON.parse` / `JSON.stringify`.
   - Rename target path `config.yaml` → `config.json` everywhere.
   - `loadWorkspaceConfig(workspacePath)`:
     - If `<workspacePath>/.flockctl/config.json` exists → read and parse.
     - Else if `<workspacePath>/.flockctl/config.yaml` exists → read YAML, write JSON next to it, delete YAML, return parsed config. One-shot conversion for local dev.
     - Else return empty config.
   - `saveWorkspaceConfig(workspacePath, config)` writes `config.json` with 2-space indent + trailing newline.

2. **`src/services/project-config.ts`**: symmetric change (same pattern as workspace-config.ts).

3. **`src/db/config-backfill.ts`**: the existing backfill writes YAML. Change it to write `config.json`. For local dev DBs that already backfilled to YAML earlier, the one-shot conversion in step 1 covers them.

4. **Do NOT remove the `yaml` npm dependency.** It's still used by [plan-store.ts](../src/services/plan-store.ts) and [prompt-resolver.ts](../src/services/prompt-resolver.ts) for `SKILL.md` and plan-file YAML frontmatter (the format Claude Code's native loader expects).

5. **Upgrade `disabledSkills` AND `disabledMcpServers` shapes during conversion.** Both fields get the same `[{name, level}]` reshape. Validator reshapes on read:
   - Bare `string[]` → array of `{name, level: "global"}` entries (heuristic: globals are the most-commonly-disabled scope). Log once per conversion.
   - Array of `{name, level}` objects → validated and passed through (level must be `"global" | "workspace" | "project"`).
   - Unknown level or malformed entry → drop with warning, do not crash.
   - The `WorkspaceConfig` / `ProjectConfig` TS types change: `disabledSkills?: Array<{ name: string; level: SkillLevel }>` and `disabledMcpServers?: Array<{ name: string; level: SkillLevel }>` (same level type).

6. **Tests**:
   - `src/__tests__/services/workspace-config.test.ts` and `project-config.test.ts` — flip YAML assertions to JSON.
   - Any fixture or helper that writes `config.yaml` → write `config.json`.
   - Keep one test per config service that verifies the one-shot YAML → JSON conversion path (reads `config.yaml`, asserts `config.json` written and YAML deleted).
   - New test: bare `string[]` `disabledSkills` in legacy YAML → converts to `{name, level:"global"}` entries after reading.
   - Symmetric test for `disabledMcpServers`.
   - New test: validator rejects entry with invalid level (for both fields).

**Verify:** `bun run test` green. Manual: delete local `flockctl.db`, start daemon → configs write as `.json`. Place a stale `config.yaml` in a test project → start daemon → confirm file converted to `config.json` and YAML removed.

### Phase 0.5 — Remove Claude Code plugin mechanism

The plugin path was useful as a bootstrap but can't express project-scoped disables. Now that the reconciler covers global skills, the plugin becomes redundant and causes duplication (plugin-exposed skills can't be hidden per-project).

1. **Delete `seedClaudeCodePlugin` from [src/config.ts](../src/config.ts#L350) and its import + call site in [src/server-entry.ts](../src/server-entry.ts#L60).** Also delete `checkRcPermissions`/`hasRemoteAuth` only if they're no longer used elsewhere (grep first).
2. **One-shot cleanup on first boot after upgrade** (new helper in `src/services/plugin-cleanup.ts` or inline in `server-entry.ts`):
   - Remove `~/flockctl/.claude-plugin/` directory (plugin.json + marketplace.json) if present.
   - Open `~/.claude/settings.json`, remove `extraKnownMarketplaces["flockctl-local"]` and `enabledPlugins["flockctl@flockctl-local"]` if present. Preserve all other user settings. Write back with 2-space indent + trailing newline.
   - Idempotent: missing keys → no-op. Safe to run on every boot; do so for simplicity (no "already cleaned up" flag).
3. **Tests**:
   - Plugin files deleted from `~/flockctl/.claude-plugin/` after boot.
   - `~/.claude/settings.json` marketplace/plugin entries removed; unrelated keys preserved.
   - Idempotent: running cleanup twice is a no-op on the second run.
   - Malformed `~/.claude/settings.json` → log error, do not crash.

**Verify:** `bun run test` green. Manual: ensure `~/.claude/settings.json` still has user's non-flockctl settings intact after daemon boot.

### Phase 1 — Reconciler skeleton (no callers yet)

New file: `src/services/claude-skills-sync.ts`

Exports:
- `reconcileClaudeSkillsForProject(projectId: number): void`
- `reconcileClaudeSkillsForWorkspace(workspaceId: number): void` — writes workspace `skills-state.json` AND `<workspace>/.claude/skills/` symlinks (so `claude` launched from workspace cwd sees the global+workspace effective set).
- `reconcileAllProjects(): void`
- `reconcileAllProjectsInWorkspace(workspaceId: number): void` — also refreshes workspace manifest.

Internal helpers:
- `computeEffectiveSkillsForProject(projectId)` — uses `resolveSkillsForProject`, returns `Array<{ name, level, sourceDir }>` (level ∈ `"global" | "workspace" | "project"`).
- `computeEffectiveSkillsForWorkspace(workspaceId)` — global + workspace only, minus workspace JSON-config disables.
- `writeManifest(flockctlDir, skills)`: writes `<flockctlDir>/skills-state.json` with stable key order + 2-space indent + trailing newline. The committed manifest contains **only** the skills list (no timestamp):
  ```json
  {
    "skills": [
      { "name": "bugfix", "level": "global" },
      { "name": "implementation", "level": "project" },
      { "name": "testing", "level": "workspace" }
    ]
  }
  ```
  Entries sorted by `name` for deterministic diffs. `source` path intentionally omitted from the committed file — paths differ per machine; `level` is the portable fact. **Byte-stable across no-op reconciles** → zero git noise.
  Before writing, read the existing file; if identical to the new content, skip the write entirely (preserves mtime, avoids FS churn and editor reload storms).
- `writeLocalReconcileMarker(flockctlDir)`: writes `<flockctlDir>/.skills-reconcile` (gitignored) with `{"reconciled_at": "<ISO-8601>"}`. Runs on every reconcile regardless of whether the manifest changed — this is the debug/drift-detection timestamp.
- `writeSymlinks(targetDir, skills)`:
  - `mkdirSync(targetDir, { recursive: true })`
  - For each existing entry in `targetDir`: `lstat`. If symlink and (target missing OR target not in new set) → remove. Non-symlink entries → leave alone with a warning.
  - For each desired link: if missing → `symlinkSync(sourceDir, join(targetDir, name))`. If points elsewhere → unlink + rewrite.
- `ensureGitignore(path)`:
  - Ensures `.claude/skills/` and `.flockctl/.skills-reconcile` are in `<path>/.gitignore` when `.gitignore` exists. Does NOT create `.gitignore` if missing (don't pollute non-git dirs); logs once.
  - `skills-state.json` and `.flockctl/config.json` are NOT gitignored — they're explicitly tracked.

**Ship as dead code.** No callers yet — lets us test in isolation.

**Parallel MCP reconciler:** new file `src/services/claude-mcp-sync.ts`.

Exports:
- `reconcileMcpForProject(projectId: number): void`
- `reconcileMcpForWorkspace(workspaceId: number): void`
- `reconcileAllMcp(): void`
- `reconcileAllMcpInWorkspace(workspaceId: number): void`

Internal helpers:
- `computeEffectiveMcpForProject(projectId)` — wraps existing `resolveMcpServersForProject`, returns `Array<{name, level, config}>`.
- `computeEffectiveMcpForWorkspace(workspaceId)` — global + workspace only, minus workspace-level disables.
- `writeMergedMcpJson(targetDir, servers)`: writes `<targetDir>/.mcp.json` in the shape Claude Code expects:
  ```json
  {
    "mcpServers": {
      "bugfinder": { "command": "...", "args": [...] },
      "lint-helper": { "command": "...", "args": [...] }
    }
  }
  ```
  Keys sorted alphabetically, 2-space indent, trailing newline. Read-diff-skip write logic identical to skills manifest (preserves mtime on no-op).
- `writeMcpManifest(flockctlDir, servers)`: writes `<flockctlDir>/mcp-state.json`:
  ```json
  {
    "mcpServers": [
      { "name": "bugfinder", "level": "global" },
      { "name": "lint-helper", "level": "project" }
    ]
  }
  ```
  Sorted by name; no `reconciled_at`. Byte-stable across no-op reconciles.
- `writeLocalMcpReconcileMarker(flockctlDir)`: writes `<flockctlDir>/.mcp-reconcile` with ISO-8601 timestamp (gitignored).
- `ensureGitignore` (shared with skills) also appends `.mcp.json` and `.flockctl/.mcp-reconcile` to `.gitignore`.

Key difference from skills reconciler: **no symlinks**, just two JSON files (`.mcp.json` + `mcp-state.json`). No stale-symlink cleanup needed — each write fully replaces the file.

**Verify:** `bun run test` still green (no behavior change).

### Phase 2 — Reconciler tests

New file: `src/__tests__/services/claude-skills-sync.test.ts`

Cases:
- Symlinks created for global + workspace + project skills; project `skills-state.json` written with correct levels.
- Project overrides workspace overrides global (same name → single symlink pointing at highest-priority source; manifest records the winning level).
- JSON `disabledSkills` at workspace/project level excludes from symlink set and from manifest.
- Stale symlinks (source removed or renamed) cleaned up on re-run; manifest updated.
- Broken symlinks (target ENOENT) cleaned up.
- Non-symlink entries in target dir left untouched with warning.
- Idempotent: two back-to-back calls = identical on-disk state, no unnecessary filesystem writes (including no manifest rewrite if content unchanged modulo `reconciled_at`).
- Workspace reconciler writes `<workspace>/.flockctl/skills-state.json` AND `<workspace>/.claude/skills/` symlinks for the global+workspace view.
- Project symlinks in `<project>/.claude/skills/` override workspace-level view for the same skill name (Claude Code's cwd is the project when launched from there).
- Manifest is deterministic: entries sorted by `name`, stable key order — diffable.
- `ensureGitignore` appends `.claude/skills/`, `.mcp.json`, `.flockctl/.skills-reconcile`, `.flockctl/.mcp-reconcile` when `.gitignore` exists, no-ops when present, skips when `.gitignore` absent.

**Parallel MCP test file:** `src/__tests__/services/claude-mcp-sync.test.ts` — mirror the skills cases:
- `.mcp.json` written with merged effective set; `mcp-state.json` written with correct levels.
- Precedence: project MCP config overrides workspace with same name, which overrides global.
- JSON `disabledMcpServers: [{name, level}]` at workspace level excludes global MCP from both workspace and project `.mcp.json`.
- Project disable of workspace-level MCP removes it from project `.mcp.json` only; workspace `.mcp.json` still has it.
- Byte-stable: same effective set → no rewrite (mtime unchanged).
- `.mcp-reconcile` file updated on every run.
- Malformed MCP config file on disk → logs and skips, reconciler completes.
- Workspace reconciler writes workspace-effective view into `<workspace>/.mcp.json` AND `<workspace>/.flockctl/mcp-state.json`.
- Concurrent calls produce correct final state without corruption.

**Verify:** both targeted test files pass.

### Phase 3 — Wire reconciler triggers & remove prompt injection (single unit)

Phases 3 and 4 ship as one commit/PR. Reconciler without injection removal = duplicate skill delivery; injection removal without reconciler = broken skills. Listed separately below for clarity; merge in review.

Files:

Both skills and MCP reconcilers are wired in the same trigger points. Call both from each site (skills first, then MCP — order doesn't matter semantically but keeps diffs readable).

1. **[src/server-entry.ts](../src/server-entry.ts)** — after `startServer(port, host)` (not before — async boot: don't block HTTP listener on reconciling N projects), schedule `reconcileAllProjects()` AND `reconcileAllMcp()` as fire-and-forget. Use `setImmediate(() => { try { reconcileAllProjects(); reconcileAllMcp(); } catch (err) { console.error(...) } })`. Catches drift from teammate pulls and prior crashes without lengthening boot time.
2. **[src/routes/workspaces.ts:245](../src/routes/workspaces.ts#L245)** — after successful config save that touches `disabledSkills` or `disabledMcpServers`: call the relevant reconciler(s) (skills-sync if skills changed, mcp-sync if MCP changed; both if unsure — cheap no-op). Always propagate to child projects via `reconcileAllProjectsInWorkspace` / `reconcileAllMcpInWorkspace`.
3. **[src/routes/projects.ts](../src/routes/projects.ts)** — after project config save: call `reconcileClaudeSkillsForProject(projectId)` + `reconcileMcpForProject(projectId)`. Also on project creation handler: both reconcilers + `ensureGitignore`.
4. **[src/routes/skills.ts](../src/routes/skills.ts) — disable toggles become body-based to carry `level`:**
   - **Old:** `POST /workspaces/:id/disabled/:name` (path param = name) / `DELETE /workspaces/:id/disabled/:name`.
   - **New:** `POST /workspaces/:id/disabled` with body `{name, level}` to add; `DELETE /workspaces/:id/disabled` with body `{name, level}` to remove. (URL can't carry a tuple cleanly; body JSON is standard for composite keys.) Returns 400 if `level` is missing or invalid, or if level is not a scope visible from this config (e.g. workspace config trying to disable `level: "project"`).
   - Symmetric for project: `POST/DELETE /projects/:pid/disabled` with body `{name, level}`.
   - After mutation → reconciler runs (`reconcileClaudeSkillsForWorkspace` + `reconcileAllProjectsInWorkspace` or `reconcileClaudeSkillsForProject`).
   - Skill file create/delete routes (lines 69–148) → reconcile affected workspace and project(s).
   - Global skill create/delete (around line 42) → `reconcileAllProjects()` + workspace manifests for all workspaces.
5. **[src/routes/mcp.ts](../src/routes/mcp.ts) — mirror skills routes for MCP:**
   - `POST/DELETE /workspaces/:id/disabled-mcp` and `/projects/:pid/disabled-mcp` with body `{name, level}` → `reconcileMcpForWorkspace` + `reconcileAllMcpInWorkspace` / `reconcileMcpForProject`.
   - MCP server create/delete routes → reconcile affected workspace and project(s) for MCP.
   - Global MCP create/delete → `reconcileAllMcp()` + workspace MCP manifests for all workspaces.
6. **[src/services/task-executor.ts:~236](../src/services/task-executor.ts#L236)** — just before `new AgentSession(...)`, call `reconcileClaudeSkillsForProject(task.projectId)` AND `reconcileMcpForProject(task.projectId)`. No task overlay, no `finally` restore.
7. **[src/routes/chats.ts:~327](../src/routes/chats.ts#L327)** — before starting chat AgentSession, if chat has a project: both reconcilers.

**Verify:**
- `bun run test` green (we're only adding triggers; inline injection still active at this phase).
- Manual (skills): add skill to workspace and project, confirm `<project>/.claude/skills/<name>` symlinks appear; disable in JSON config, confirm symlink disappears on config save.
- Manual (MCP): add MCP server at workspace level, confirm `<project>/.mcp.json` contains it; disable in JSON config with `{name, level:"workspace"}`, confirm entry removed from project `.mcp.json`.

### Phase 4 — Remove prompt injection

1. **[src/services/agent-session.ts:455-460](../src/services/agent-session.ts#L455-L460)** — delete `<skills>` XML block.
2. **[src/services/agent-session.ts:462-472](../src/services/agent-session.ts#L462-L472)** — delete `<available_mcp_servers>` XML block (Claude Code reads MCP from `.mcp.json` natively).
3. **[src/services/agent-session.ts:25-46](../src/services/agent-session.ts#L25-L46)** — remove `skills: Skill[]` AND `mcpServers: McpServerInfo[]` from `AgentSessionOptions`. Remove `Skill` and `McpServerInfo` imports/interface if now unused.
4. **[src/services/agent-session.ts:448-452](../src/services/agent-session.ts#L448-L452)** — the `FLOCKCTL SKILL DIRECTORIES (NOT ~/.claude/)` instruction block: update wording — skills still come from `.flockctl/skills/` (source of truth), but symlinks in `.claude/skills/` are how Claude Code sees them. Rewrite to avoid contradicting reality now that symlinks exist in `.claude/skills/`. Probably: keep telling the agent "create skills in `.flockctl/skills/`" (that's the authoritative location), and note symlinks are auto-managed. Add parallel line for MCP: "create MCP configs in `.flockctl/mcp/`; `.mcp.json` is auto-managed, do not edit manually".
5. **[src/services/task-executor.ts:159,240](../src/services/task-executor.ts#L159)** — remove `resolveSkillsForTask` and `resolveMcpServersForTask` calls and `skills`/`mcpServers` props from `AgentSession` construction.
6. **[src/routes/chats.ts:331](../src/routes/chats.ts#L331)** — remove `skills: []` line AND `mcpServers` line if present.
7. **[src/services/plan-prompt.ts](../src/services/plan-prompt.ts)** — rewrite. The new prompt is a minimal template containing:
   - (a) user description.
   - (b) target directory for plan files.
   - (c) **explicit mode directive**: literal string `Use the "planning" skill's "Quick Mode" section for structure.` or `... "Deep Mode" section ...`. Must name the skill AND the section — the model loads the skill, reads the right section, follows it. Do NOT say just "quick mode" or "use the planning skill"; be explicit so the model can't pick the wrong section.
   - (d) short reminder: "The `planning` skill is available via the Skill tool; load it before writing any plan files."
   
   Delete all skill-file reading and inline injection. Keep `buildCodebaseContext` call if codebase context is still useful inline (this is git diff/status output, not a skill — keep it). Task-executor already calls reconciler before session start (Phase 3), so `planning` skill is in `<project>/.claude/skills/` when the plan task runs — Claude Code auto-loads name+description, model invokes Skill tool as needed. Remove `resolveSkillsForProject` import, `loadPlanningSkill`, `extractModeSection`, `extractPlanStructure`, `stripFrontmatter` functions entirely.
8. **[src/services/skills.ts](../src/services/skills.ts)** — keep `resolveSkillsForProject` (used by reconciler and plan-prompt). `resolveSkillsForTask` can be deleted in Phase 5 when task-level concept goes.
9. **[src/services/mcp.ts](../src/services/mcp.ts)** — keep `resolveMcpServersForProject` (used by reconciler). `resolveMcpServersForTask` deleted in Phase 5.

**Verify:**
- Update `src/__tests__/services/agent-session*.test.ts` — assertions about `<skills>` and `<available_mcp_servers>` block presence → flip to absence.
- `bun run test` green.
- Manual: run a task that uses a skill; confirm log shows Claude Code invoking Skill tool (native loader) rather than skill content in prompt.
- Manual (MCP): run a task in a project with an MCP server; confirm Claude Code starts the MCP subprocess (per its native `.mcp.json` discovery) and tools from that server appear in tool_call logs. Confirm system prompt contains no `<available_mcp_servers>`.
- Token savings check: input-token count on a baseline task should drop by the combined size of skills + MCP inlined content.

### Phase 4.5 — Skill tool: allowlist + visibility in task and chat logs

**Goal:** (a) ensure `Skill` tool doesn't trigger a permission prompt on every skill load in `auto` mode — that would turn progressive disclosure into a UX disaster. (b) Give users visible evidence that progressive disclosure is working by rendering Skill invocations in both task and chat logs. (c) Persist chat tool events so refresh doesn't lose history (parity with tasks).

**Current state (pre-migration):**
- [src/services/permission-resolver.ts:105](../src/services/permission-resolver.ts#L105) `READ_ONLY_TOOLS` does NOT include `Skill`. In `auto` mode `decideAuto` falls through to `"tool X requires approval"` → the user is prompted for every on-demand skill load. UX disaster once progressive disclosure is active.
- [src/services/agent-session.ts:281-288](../src/services/agent-session.ts#L281-L288) emits unified `tool_call` / `tool_result` events for every tool the SDK reports — `Skill` included. No work needed at the session layer.
- [src/services/task-executor.ts:256-261](../src/services/task-executor.ts#L256-L261) already forwards `tool_call` / `tool_result` to `appendLog` → DB row → WebSocket broadcast. Tasks already render Skill calls, but formatted via the `default` branch of [formatToolCall](../src/services/task-executor.ts#L46) as `🔧 Skill {"name":"planning"}` — technically correct, visually poor.
- [src/services/chat-executor.ts](../src/services/chat-executor.ts) does **not** forward `tool_call` / `tool_result` at all — only `permission_request`. Chat UI sees raw text only. Skill invocations are invisible in chats today, and even if broadcast via WS they'd be lost on page refresh (chats persist only the final assistant text in `chat_messages`).
- [src/routes/chats.ts:489-496](../src/routes/chats.ts#L489-L496) registers `text` / `usage` / `session_id` / `error` handlers but never `tool_call`. Tool activity in chats is lost.

**Changes:**

1. **Add `Skill` to `READ_ONLY_TOOLS`** in [src/services/permission-resolver.ts:105](../src/services/permission-resolver.ts#L105). Loading a skill body mutates nothing; it's strictly a read of content Swarmctl placed there itself. `auto` mode auto-allows it; `default` mode still prompts (by mode definition).

2. **Extract tool formatters into `src/services/tool-format.ts`** (new module): move `formatToolCall` / `formatToolResult` / `truncate` from [task-executor.ts:46-86](../src/services/task-executor.ts#L46-L86). Single source of truth; one test suite. Add Skill case:
   ```ts
   case "Skill":
   case "skill": {
     const skillName = String(input.name ?? input.skill ?? "unknown");
     const args = input.args ? ` — ${truncate(String(input.args), 120)}` : "";
     return `📚 Skill: ${skillName}${args}`;
   }
   ```
   `formatToolResult` stays generic; skill bodies get truncated to 300 chars like any other tool result.

3. **Persist chat tool events in `chat_messages`** — parity with task logs. Two sub-changes:
   - **Schema migration** `migrations/0024_chat_messages_role_tool.sql`: no column change (`role` is already `TEXT`), just document that `role` now accepts `"tool"` in addition to `"user"` / `"assistant"`. `content` stores a JSON string `{"kind":"tool_call"|"tool_result","tool_name":"Skill","body":"📚 Skill: planning"}`. No new table — reuse existing ordering (`createdAt` index already covers it). If an explicit check constraint on `role` exists, widen it; verify via schema read.
   - **`chat-executor.ts.register()`** — new handlers insert a `chat_messages` row AND broadcast WS:
     ```ts
     session.on("tool_call", (name, input) => {
       const body = formatToolCall(name, input);
       const content = JSON.stringify({ kind: "tool_call", tool_name: name, body });
       const row = db.insert(chatMessages).values({ chatId, role: "tool", content }).run();
       wsManager.broadcastChat(chatId, {
         type: "tool_event",
         payload: { id: String(row.lastInsertRowid), chat_id: String(chatId), kind: "tool_call", tool_name: name, body, created_at: new Date().toISOString() },
       });
     });
     session.on("tool_result", (name, output) => { /* symmetric, kind: "tool_result" */ });
     ```
     Tool rows interleave naturally with user/assistant rows in creation order; chat history loader renders them inline.

4. **Chat history loader** — wherever `chat_messages` rows are fetched for UI rendering (likely a `GET /chats/:id/messages` route), return `role: "tool"` rows alongside user/assistant rows. Parse `content` JSON and expose `{kind, tool_name, body}` in the response shape.

5. **Chat UI rendering** — `ui/src/pages/chat-detail.tsx` (or equivalent): render `role: "tool"` messages inline between user/assistant turns as a compact monospace line (same blue tone `tool_call` color token task-detail uses at [task-detail.tsx:76-80](../ui/src/pages/task-detail.tsx#L76-L80)). `tool_call` kind = blue; `tool_result` kind = green. Skill uses the 📚 icon already baked into `formatToolCall`.

6. **Delete dead code** — once extracted, remove `formatToolCall` / `formatToolResult` / `truncate` from `task-executor.ts`; import from `src/services/tool-format.ts`.

**Tests:**
- `src/__tests__/services/permission-resolver.test.ts`: `decideAuto("Skill", {}, roots)` returns `behavior: "allow"` with reason `"read-only tool"`.
- `src/__tests__/services/tool-format.test.ts` (new):
  - `Skill` with `{name:"planning"}` → `📚 Skill: planning`.
  - `Skill` with `{name:"planning", args:"init"}` → `📚 Skill: planning — init`.
  - `Skill` with missing name → `📚 Skill: unknown`.
  - Unknown tool still goes through default branch.
  - Truncation caps at 300 chars for results.
- `src/__tests__/services/chat-executor.test.ts` (new or extended):
  - `register()` `tool_call` handler inserts `chat_messages` row with `role: "tool"` and JSON content `{kind:"tool_call", tool_name, body}`.
  - Broadcast fires after insert with the row id.
  - Symmetric for `tool_result`.
  - `unregister()` cleans up listeners.
- `src/__tests__/routes/chats-messages.test.ts` (extend): history endpoint returns `role: "tool"` rows in creation order interleaved with user/assistant.
- UI smoke: render test feeding a history response with a `role: "tool"` entry; assert `📚 Skill: planning` appears in the message list.
- Schema migration test: assert migration 0024 registered in `_journal.json` and helpers.ts test schema covers `role: "tool"`.

**Verify:**
- `bun run test` green.
- Manual task: run a task using a skill → DB row exists with `stream_type="tool_call"` and content starting `📚 Skill:`.
- Manual chat: send chat that triggers Skill use → browser devtools WS frames show `tool_call` / `tool_result` messages; chat UI renders them inline.
- Regression: non-Skill tools (Bash/Read/Edit/…) still format exactly as before.

### Phase 5 — Drop task-level disable feature + DB columns

Pre-release — no data to preserve, no dump step, forward-only migration. Applies to **both** `disabled_skills` and `disabled_mcp_servers`.

1. **New migration** `migrations/0023_drop_task_disabled_skills_and_mcp.sql`:
   ```sql
   ALTER TABLE tasks DROP COLUMN disabled_skills;
   ALTER TABLE tasks DROP COLUMN disabled_mcp_servers;
   ```
   Add to `migrations/meta/_journal.json`.
2. **[src/db/schema.ts:74](../src/db/schema.ts#L74)** — remove `disabledSkills: text("disabled_skills")` AND `disabledMcpServers: text("disabled_mcp_servers")`.
3. **[src/services/skills.ts:131-143](../src/services/skills.ts#L131-L143)** — delete `resolveSkillsForTask`.
4. **[src/services/mcp.ts:165-176](../src/services/mcp.ts#L165-L176)** — delete `resolveMcpServersForTask`.
5. **[src/routes/skills.ts:260-285](../src/routes/skills.ts#L260-L285)** — delete POST/DELETE `/tasks/:tid/disabled` routes entirely.
6. **[src/routes/mcp.ts](../src/routes/mcp.ts)** — delete task-level disable routes (symmetric set to skills).
7. **[src/routes/tasks.ts:158](../src/routes/tasks.ts#L158)** — remove `disabledSkills` AND `disabledMcpServers` from task INSERT. **Input validation**: if either appears in request body, return `400 { error: "field X removed — task-level disable is no longer supported" }`. Use explicit unknown-field check, not silent ignore.
8. **[src/routes/tasks.ts:234](../src/routes/tasks.ts#L234)** — remove both fields from `/tasks/:id/rerun` clone.
9. **[src/services/task-executor.ts:393](../src/services/task-executor.ts#L393)** — remove both fields from auto-retry payload.
10. **[src/__tests__/helpers.ts:152](../src/__tests__/helpers.ts#L152)** — remove both column defs from test DB schema.
11. **Tests to delete/rewrite:**
    - `src/__tests__/routes/skills-extra.test.ts:179-217` — delete task-disable sections.
    - `src/__tests__/routes/mcp.test.ts` — delete task-disable-MCP sections.
    - `src/__tests__/routes/tasks-extra.test.ts:57-71` — drop both fields from the "stores envVars, disabledSkills, disabledMcpServers as JSON" test (rename to just envVars).
    - Add: `POST /tasks` with `disabledSkills` or `disabledMcpServers` in body returns 400 with explanatory error.
    - `src/__tests__/services/task-executor*.test.ts` — remove `resolveSkillsForTask` AND `resolveMcpServersForTask` mocks.
12. **UI check:** grep confirmed no UI uses task-level disable for either surface. No UI work.

**Verify:**
- `bun run test` green.
- Manual: fresh daemon boot → migration runs → no errors, both columns gone.
- Manual: create task via POST /tasks with `disabledSkills` or `disabledMcpServers` in body → 400.

### Phase 6 — Sharing, gitignore, docs

1. **Docs:** this file (`docs/SKILLS-MIGRATION.md`) serves as the migration record. Also update `docs/CONCEPTS.md` or `docs/ARCHITECTURE.md` to document the split between **committed source of truth** and **generated local view** for both skills and MCP:
   
   **Committed (source of truth):**
   - `.flockctl/skills/` — skill bodies (`SKILL.md` files).
   - `.flockctl/mcp/` — MCP server configs (`<name>.json`).
   - `.flockctl/config.json` — disables (`disabledSkills`, `disabledMcpServers` as `[{name, level}]`) + other workspace/project config.
   - `.flockctl/skills-state.json` — reconciled effective skill list (auto-generated, do not edit manually).
   - `.flockctl/mcp-state.json` — reconciled effective MCP server list (auto-generated, do not edit manually).
   
   **Gitignored (generated locally):**
   - `.claude/skills/` — symlink farm Claude Code reads.
   - `.mcp.json` — merged MCP config Claude Code reads.
   - `.flockctl/.skills-reconcile` — local reconcile timestamp (skills).
   - `.flockctl/.mcp-reconcile` — local reconcile timestamp (MCP).
   
   **How to disable a skill or MCP server:** edit `.flockctl/config.json` (or use the UI, which writes the JSON). Entries are `{name, level}` objects; `level` targets which scope's skill/server you want hidden at this config's level.
2. **`ensureGitignore`** triggered on project and workspace creation (Phase 3) — appends all four gitignored paths atomically. Confirm in integration test. Shared helper between skills and MCP reconcilers (single write, all four patterns).
3. **Workspace `.claude/skills/` and workspace `.mcp.json`** are created symmetrically to project-level — for users who run `claude` from workspace cwd (cross-project work). Workspace `.mcp.json` contains global+workspace effective MCP set; workspace `.claude/skills/` contains global+workspace effective skill symlinks. Reconciler calls `ensureGitignore(workspacePath)` on workspace creation/config save.
4. **Teammate trade-off (documented, not fixed):** teammates who open a Swarmctl project in Claude Code **without** running the flockctl daemon first will have no `.mcp.json` and no `.claude/skills/` — Claude Code will see none of the project's skills or MCP servers. This is intentional: those files are generated locally and must be reconciled on each machine. Docs must call this out under a "Using a Swarmctl project on another machine" section: `flockctl daemon` (or a one-shot `flockctl reconcile` if we add one later) is a prerequisite alongside the clone.

**Verify:** manual — `git status` in a fresh project after reconcile: no `.claude/skills/`, no `.mcp.json`, no `.flockctl/.skills-reconcile`, no `.flockctl/.mcp-reconcile` in the "untracked" list. Committed `skills-state.json` and `mcp-state.json` present.

### Phase 7 — Cross-cutting test suite

Goal: every behavioral change, every removed code path, every new file has at least one test. Pruned of anti-patterns (grep-the-source "tests", flaky token-count assertions, "if time permits" entries — if a test isn't worth writing, leave it out). Grouped by surface.

**Reconciler (core)** — `src/__tests__/services/claude-skills-sync.test.ts`:
- All cases from Phase 2 (symlink creation, precedence, disables, stale cleanup, broken cleanup, idempotence, manifest structure, `ensureGitignore`).
- Byte-stability: same effective set across two back-to-back runs — manifest file unchanged (no mtime bump, no content diff). Critical to prove zero git noise.
- Manifest sort order: skills always alphabetized by name.
- Manifest shape: top-level key is `skills` only (no `reconciled_at`); each entry has exactly `name` + `level`; `level` ∈ `"global" | "workspace" | "project"`; no absolute paths; 2-space indent + trailing newline.
- `.flockctl/.skills-reconcile` written with ISO-8601 timestamp on every run (even no-op manifest).
- Missing `.flockctl/skills/` on any level: reconciler no-ops for that level, doesn't crash.
- Missing global skills dir: no-op.
- Empty config files (no `disabledSkills`): all resolved skills pass through.
- Malformed `config.json` at any level: logs error, treats as empty config, does not crash reconciler.
- Workspace with zero projects: workspace reconciler still writes workspace-level manifest + symlinks.
- Project without workspace (orphan): reconciler runs with global + project only.
- Concurrent calls to `reconcileClaudeSkillsForProject(id)`: final state is correct (both finish without corruption).
- Skill name with special chars (dots, hyphens): symlink + manifest entry both handle correctly.

**Reconciler integration** — `src/__tests__/services/claude-skills-sync-integration.test.ts` (new):
- Full workflow: create workspace record (tmpdir) → create project record (tmpdir) → add skills at all three levels → boot reconciler → verify `.claude/skills/` symlinks at both workspace and project dirs → verify `skills-state.json` at both levels.
- Add workspace disable in `config.json` → re-reconcile → verify skill removed from project symlinks AND workspace symlinks AND both manifests.
- Add project skill with same name as workspace skill → verify project wins in project view, workspace unaffected in workspace view.
- Delete a workspace-level skill file → re-reconcile → verify symlink and manifest entry removed.
- Simulated teammate clone: new project dir with committed `.flockctl/skills/`, `.flockctl/config.json`, `.flockctl/skills-state.json` but no `.claude/skills/` → boot reconciler → verify `.claude/skills/` populated to match committed `skills-state.json`.
- Pre-existing `.claude/skills/` with broken absolute symlinks (from another machine): reconciler replaces them with correct local ones.

**MCP reconciler (core)** — `src/__tests__/services/claude-mcp-sync.test.ts`:
- All cases from Phase 2 (merged `.mcp.json` write, `mcp-state.json` write, precedence, disables, byte-stability, `.mcp-reconcile` timestamp).
- Manifest shape: top-level key is `mcpServers` only (no `reconciled_at`); each entry has exactly `name` + `level`; sorted by name; 2-space indent + trailing newline.
- `.mcp.json` shape: `{mcpServers: {<name>: <config>, ...}}`, keys alphabetized, 2-space indent + trailing newline.
- Option A behavior: global MCP from `~/flockctl/mcp/` appears copied into each project's `.mcp.json` — reconciler never touches `~/.claude.json` (spy on write path).
- Disabled with `{name:"X", level:"global"}` at workspace config → global X excluded from BOTH workspace `.mcp.json` AND all descendant project `.mcp.json`s.
- Disabled with `{name:"X", level:"workspace"}` at project config → workspace X hidden in that project's `.mcp.json`; workspace `.mcp.json` unaffected.
- Empty `disabledMcpServers`: all effective servers pass through.
- Malformed `config.json` at any level: logs and treats as empty, reconciler completes.
- Malformed MCP config file on disk (e.g. invalid JSON in `.flockctl/mcp/broken.json`): logs and skips that server, reconciler completes for the rest.
- Concurrent calls produce correct final state without corruption (both merge-writes and manifest writes survive race).

**MCP reconciler integration** — `src/__tests__/services/claude-mcp-sync-integration.test.ts` (new):
- Full three-level workflow: global + workspace + project MCP servers → `.mcp.json` at both workspace and project dirs contains correct merged set; `mcp-state.json` at both levels matches.
- Teammate clone: committed `.flockctl/mcp/`, `.flockctl/config.json`, `.flockctl/mcp-state.json` but no `.mcp.json` → boot reconciler → `.mcp.json` populated.
- Stale `.mcp.json` from another machine (different absolute paths in `command`/`args`) → reconciler replaces it with the current-machine view.

**Phase 0 (JSON config migration)** — `src/__tests__/services/workspace-config.test.ts`, `project-config.test.ts`:
- Load `config.json` when both YAML and JSON exist: JSON wins.
- Load only `config.yaml` (legacy): one-shot converts to JSON, deletes YAML, returns parsed content.
- Load only `config.json`: returns parsed.
- Load neither: returns empty.
- Save writes `config.json` only (never YAML).
- Conversion preserves all known fields (`disabledSkills`, `disabledMcpServers`, `permissionMode`, etc.).
- Malformed YAML during conversion: logs error, falls back to empty, does NOT delete the malformed YAML.
- Malformed JSON on load: logs error, falls back to empty.

**Phase 0.5 (plugin teardown)** — `src/__tests__/services/plugin-cleanup.test.ts` (new):
- After cleanup: `~/flockctl/.claude-plugin/` removed.
- `~/.claude/settings.json` has no `flockctl-local` marketplace entry, no `flockctl@flockctl-local` enabled entry.
- Unrelated user keys in settings.json preserved exactly.
- Idempotent: second invocation is a no-op.
- Malformed settings.json: logs and skips, does not crash daemon.

**Phase 3 + 4 (triggers + injection removal)** — `src/__tests__/services/agent-session*.test.ts`:
- Built system prompt does NOT contain the `<skills>` XML block.
- Built system prompt does NOT contain the `<available_mcp_servers>` XML block.
- Task-executor calls `reconcileClaudeSkillsForProject` AND `reconcileMcpForProject` before `new AgentSession(...)` (spies).
- Task-executor does NOT pass `skills` or `mcpServers` to `AgentSession` (fixture shape assertion).
- Chat routes call both reconcilers when chat is project-scoped (spies).
- Removed identifiers (`resolveSkillsForTask`, `resolveMcpServersForTask`, `AgentSessionOptions.skills`, `AgentSessionOptions.mcpServers`, plan-prompt helpers) are caught as absent by TypeScript compilation — enforced by the normal `tsc` step in CI, not reified as a runtime test.

**Phase 4 (plan-prompt refactor)** — `src/__tests__/services/plan-prompt.test.ts`:
- `buildPlanGenerationPrompt()` output contains the literal mode directive string for each mode (`Quick Mode` / `Deep Mode`) and names the `planning` skill explicitly.
- Output does NOT contain extracted skill content (no `## Plan Structure` or `## Mode: …` blocks copied from the skill body).
- Output contains user description and target dir.
- `resolveSkillsForProject` is NOT called from plan-prompt (spy).

**Phase 4.5 (Skill tool allowlist + visibility)**:
- `src/__tests__/services/permission-resolver.test.ts`: `decideAuto("Skill", ...)` returns `behavior: "allow"` with `"read-only tool"` reason.
- `src/__tests__/services/tool-format.test.ts`: Skill-case matrix (see Phase 4.5 test list).
- `src/__tests__/services/chat-executor.test.ts`: tool_call / tool_result events insert `chat_messages` rows with `role:"tool"` and JSON content; broadcast fires with row id.
- `src/__tests__/routes/chats-messages.test.ts`: history endpoint returns `role:"tool"` rows interleaved with user/assistant rows in creation order.

**Phase 5 (DB + task-disable removal)**:
- Drizzle migration 0023 is registered in `_journal.json`; `src/__tests__/helpers.ts` test DB schema has no `disabled_skills` column AND no `disabled_mcp_servers` column.
- `POST /tasks` with `disabledSkills` in body → **400** with explanatory error message.
- `POST /tasks` with `disabledMcpServers` in body → **400** with explanatory error message.
- `POST /skills/tasks/:tid/disabled` → 404. `DELETE /skills/tasks/:tid/disabled/:name` → 404.
- Task-level MCP disable routes → 404 (symmetric deletion).
- `/tasks/:id/rerun` on an existing task: succeeds; new task uses full effective skill + MCP set.

**Skills resolution** — `src/__tests__/services/skills.test.ts`:
- Keep all `resolveSkillsForProject` tests (function stays).
- Delete all `resolveSkillsForTask` tests (function removed).
- Add: workspace `disabledSkills: [{name:"X", level:"global"}]` → global `X` excluded, workspace `X` (if exists) passes through.
- Add: workspace `disabledSkills: [{name:"X", level:"workspace"}]` → workspace `X` excluded, global `X` still visible.
- Add: project `disabledSkills: [{name:"X", level:"workspace"}]` → workspace `X` hidden in project view, workspace view itself unchanged.
- Add: multiple entries `[{X,global}, {X,workspace}]` → both hidden.
- Add: precedence — project-level skill with same name as workspace-level shadows in project view regardless of disables.
- Add: validator rejects `disabledSkills` entry with invalid level or missing `name`.

**Route tests** — `src/__tests__/routes/skills-extra.test.ts`:
- Keep workspace disable toggle tests — body shape changes from path-param to `{name, level}` in body. Test each valid `level`.
- Keep project disable toggle tests — same body-shape update; project config can target any of the three levels.
- Delete all task disable tests.
- Add: after toggle, reconciler ran (mock reconciler, assert called with correct arg).
- Add: POST `/disabled` with missing `level` → 400.
- Add: POST `/disabled` with invalid `level` (e.g. `"nope"`) → 400.
- Add: workspace POST `/disabled` with `level:"project"` → 400 (workspace config can't target project scope).

**Route tests** — `src/__tests__/routes/mcp.test.ts`:
- Workspace and project MCP disable toggles: POST/DELETE `/workspaces/:id/disabled-mcp` and `/projects/:pid/disabled-mcp` with body `{name, level}` — mirror skill route tests.
- After toggle, MCP reconciler ran.
- Delete all task-level MCP disable tests.
- Validation: missing/invalid `level` → 400; workspace targeting `level:"project"` → 400.

**Route tests** — `src/__tests__/routes/tasks-extra.test.ts`:
- Delete `disabledSkills` AND `disabledMcpServers` assertions from "stores envVars, disabledSkills, disabledMcpServers" test; rename to just "stores envVars" and narrow scope.
- Add: both fields in POST body → 400 with explanatory error (covered by Phase 5 block above; referenced here for discoverability).

**MCP resolution** — `src/__tests__/services/mcp.test.ts`:
- Keep all `resolveMcpServersForProject` / `resolveMcpServersForWorkspace` tests.
- Delete all `resolveMcpServersForTask` tests (function removed).
- Add: `disabledMcpServers: [{name:"X", level:"global"}]` at workspace → global X excluded from workspace and project views.
- Add: `disabledMcpServers: [{name:"X", level:"workspace"}]` at project → workspace X hidden in project view only.
- Add: validator rejects entry with invalid level / missing name (reuse validator from skills path).

**E2E smoke (live tier)** — one test, not optional:
- Start full daemon → create workspace + project in tmp → add a skill AND an MCP server → create a task → verify task log contains a row with `stream_type="tool_call"` and content starting `📚 Skill:` (skills progressive disclosure worked end-to-end) AND at least one tool_call row from the MCP-provided tool (MCP discovery worked end-to-end via `.mcp.json`).
- Same test covers chat flow: send a chat turn in the same project that triggers skill + MCP use → `chat_messages` has `role:"tool"` rows for both.

**Final gate:** PR merge requires (a) `bun run test` green, (b) every item in the lists above has a corresponding test file/block, (c) CHANGELOG entry mentioning the removals (task-disable feature, YAML config format, inline skill injection, plugin mechanism).

---

## Rollback & backwards-compatibility

Pre-release (see memory `project_swarmctl_prerelease`) → forward-only migrations, no feature flags, no dual-format support.

- **Phases 0 – 4.5:** additive or replace-in-place. Revert by `git revert` of the phase commit.
- **Phase 5:** DB column drop is destructive. No dump (no users = no data to preserve). To reverse: revert the migration commit, Drizzle picks up the re-added column on next boot.

**API breaking changes (intentional):**
- `POST /skills/tasks/:tid/disabled` and `DELETE /skills/tasks/:tid/disabled/:name` — removed (404).
- Task-level MCP disable routes — removed (404).
- `POST /tasks` body: `disabledSkills` OR `disabledMcpServers` field → **400** with explanatory error.
- Workspace/project skill-disable routes: `POST/DELETE /workspaces/:id/disabled/:name` → replaced by body-based `POST/DELETE /workspaces/:id/disabled` with `{name, level}` JSON. Old path-param shape returns 404.
- Workspace/project MCP-disable routes: symmetric — path-param form removed, body-based `{name, level}` form added under `/disabled-mcp`.
- `config.yaml` at workspace/project level → auto-converted to `config.json` on first boot; no dual-read.
- `disabledSkills` / `disabledMcpServers` in `config.json`: shape changes from `string[]` to `[{name, level}]`. Legacy bare strings heuristically migrated to `{level:"global"}` entries on first read.

---

## Risks & gotchas

1. **Broken symlinks from old repos** — if a teammate's repo had `.claude/skills/` committed before we added gitignore, those symlinks would be broken on their machine (absolute paths to previous owner's filesystem). Reconciler cleans broken symlinks on every trigger. Document in README: "if you see unexpected files, reconcile runs on server start".

2. **Claude Code caches skill metadata** — if a skill is removed via symlink deletion mid-session, Claude Code's currently-active session may still have the skill in context. Acceptable: next session reflects new state.

3. **Non-symlink entries in `.claude/skills/`** — user may hand-place a skill file. Reconciler leaves non-symlink entries alone (warning logged). Do not touch hand-placed skills; they're outside Swarmctl's source of truth.

4. **Server-entry order** — `reconcileAllProjects()` depends on DB migrations, `seedBundledSkills`, and the plugin cleanup step. Call strictly after those, and schedule async so it doesn't block the HTTP listener:
   ```
   runMigrations()
   seedDefaultKey()
   seedBundledSkills()
   cleanupClaudeCodePlugin()   ← Phase 0.5
   startServer(port, host)
   setImmediate(() => reconcileAllProjects())    ← async, post-listen
   ```

5. **AgentSession system prompt references `.flockctl/` as skill location** ([src/services/agent-session.ts:448-452](../src/services/agent-session.ts#L448-L452)). After migration, that's still correct as the **authoritative** location (source of truth for `SKILL.md` files). Swarmctl manages `.claude/skills/` as generated view. Keep the instruction.

6. **`Skill` in auto-mode allowlist is a policy choice.** Loading a skill body reads a file Swarmctl itself placed in `.claude/skills/` — not arbitrary filesystem access. But a malicious/confused skill body could contain prompts that steer the model. Mitigation: the skill corpus is already vetted by workspace/project owners (they committed it), so no new attack surface vs. today's inline injection. If future skill provenance widens (auto-installed from registry), revisit.

7. **Chat tool events use `role: "tool"` in existing `chat_messages` table** — any code path that filters chat messages by role (e.g. usage aggregation, export) must be audited to either accept or explicitly skip the new role. Grep for `role ===` and `role IN` in chat contexts during Phase 4.5.

8. **Teammate without flockctl daemon sees no MCP servers / skills.** `.mcp.json` and `.claude/skills/` are gitignored — they exist only after the daemon has reconciled. A collaborator who clones the repo and opens it in Claude Code directly (no `flockctl` running) will see zero MCP servers and zero project skills. This is the intentional trade-off of Option A + symlink reconciliation: we gain byte-stable committed state (`skills-state.json` / `mcp-state.json`) and clean per-project disables, and accept that reconciliation is a required step per-machine. Documented in README + Phase 6 docs. If this friction becomes a problem, we can ship a `flockctl reconcile` one-shot CLI command separate from `daemon`.

9. **Duplication of global MCP configs across `.mcp.json` files.** Option A copies global MCP server entries into every project's and workspace's `.mcp.json`. Disk footprint is trivial (these files are tiny), but the duplication means: (a) if a user has machine-local paths in a global MCP `command` (e.g. absolute binary path), every `.mcp.json` bakes in that path — fine since `.mcp.json` is gitignored; (b) rotating a global MCP secret means every `.mcp.json` gets rewritten — fine since the reconciler runs on daemon boot and on config save.

10. **MCP `command` fields with absolute paths leak machine state.** Same mitigation as #9: `.mcp.json` is gitignored. Users who commit `.flockctl/mcp/<name>.json` with `{"command": "/Users/alice/…"}` have the same problem they already have today — not new to this migration. Leave as-is.

11. **Reconciler write order.** Skills reconciler and MCP reconciler both run on the same trigger points. Both write to `<project>` and `<workspace>` dirs independently — no cross-dependency. Run them concurrently inside a single trigger (Promise.all) once the functions are async-safe; for now sequential is fine (sub-millisecond difference).

---

## Implementation order summary

Skills and MCP work is interleaved phase-by-phase — both surfaces move together in the same commits/PRs. Separating them would create half-migrated states (e.g. skills reconciled but MCP still injected in prompts) that are harder to review than a single parallel rewrite.

1. **Phase 0** — config YAML → JSON (one-shot). `yaml` npm package stays (plan/SKILL frontmatter). `disabledSkills` AND `disabledMcpServers` both reshaped to `[{name, level}]`.
2. **Phase 0.5** — remove `seedClaudeCodePlugin` + one-shot cleanup of `~/flockctl/.claude-plugin/` and `~/.claude/settings.json` entries. (Skills-only; MCP has no equivalent legacy bootstrap to remove.)
3. **Phase 1** — reconciler skeletons for skills AND MCP (both dead code, ship together).
4. **Phase 2** — reconciler tests for both.
5. **Phases 3 + 4 + 4.5 together** — wire triggers (both reconcilers on same trigger points), remove BOTH prompt injections (`<skills>` + `<available_mcp_servers>`), allowlist `Skill`, surface tool calls in task AND chat logs (with persistence). Single PR: splitting these creates duplicate delivery or UX regressions.
6. **Phase 5** — single migration drops BOTH `disabled_skills` and `disabled_mcp_servers` columns. Strict 400 on both removed fields in POST /tasks. Task-level disable routes deleted for both.
7. **Phase 6** — docs + gitignore polish: `.claude/skills/`, `.mcp.json`, `.flockctl/.skills-reconcile`, `.flockctl/.mcp-reconcile` all gitignored; `skills-state.json`, `mcp-state.json` committed.
8. **Phase 7** — cross-cutting tests for both surfaces (overlaps with each phase; final gate).

---

## Critical files touched

**New files:**
- [src/services/claude-skills-sync.ts](../src/services/claude-skills-sync.ts) (new — skills reconciler)
- [src/services/claude-mcp-sync.ts](../src/services/claude-mcp-sync.ts) (new — MCP reconciler)
- [src/services/tool-format.ts](../src/services/tool-format.ts) (new — shared `formatToolCall` / `formatToolResult`)
- [src/services/plugin-cleanup.ts](../src/services/plugin-cleanup.ts) (new — Phase 0.5 one-shot)
- `migrations/0023_drop_task_disabled_skills_and_mcp.sql` (new — drops both DB columns)
- `migrations/0024_chat_messages_role_tool.sql` (new — widen role check if any)

**Modified (core services):**
- [src/services/permission-resolver.ts](../src/services/permission-resolver.ts) (add `Skill` to `READ_ONLY_TOOLS`)
- [src/services/agent-session.ts](../src/services/agent-session.ts) (drop both `<skills>` and `<available_mcp_servers>` XML injection; drop `skills` + `mcpServers` from `AgentSessionOptions`)
- [src/services/task-executor.ts](../src/services/task-executor.ts) (remove both `resolveSkillsForTask` + `resolveMcpServersForTask` calls; add both reconciler calls)
- [src/services/chat-executor.ts](../src/services/chat-executor.ts) (persist tool events)
- [src/services/skills.ts](../src/services/skills.ts) (delete `resolveSkillsForTask`)
- [src/services/mcp.ts](../src/services/mcp.ts) (delete `resolveMcpServersForTask`)
- [src/services/plan-prompt.ts](../src/services/plan-prompt.ts)
- [src/services/workspace-config.ts](../src/services/workspace-config.ts) (YAML → JSON; reshape `disabledSkills` + `disabledMcpServers`)
- [src/services/project-config.ts](../src/services/project-config.ts) (same as workspace-config)
- [src/config.ts](../src/config.ts) (remove `seedClaudeCodePlugin`)

**Modified (routes):**
- [src/routes/skills.ts](../src/routes/skills.ts) (body-based `{name, level}` disable routes; delete task-disable routes)
- [src/routes/mcp.ts](../src/routes/mcp.ts) (body-based `{name, level}` disable routes; delete task-disable routes)
- [src/routes/tasks.ts](../src/routes/tasks.ts) (400 on both `disabledSkills` + `disabledMcpServers`; remove from INSERT + rerun clone)
- [src/routes/chats.ts](../src/routes/chats.ts) (remove injection props; add tool-event persistence)
- [src/routes/projects.ts](../src/routes/projects.ts) (trigger both reconcilers on project create/config save)
- [src/routes/workspaces.ts](../src/routes/workspaces.ts) (trigger both reconcilers on workspace config save)

**Modified (boot + schema):**
- [src/server-entry.ts](../src/server-entry.ts) (remove plugin seed, add cleanup + async reconcile for BOTH skills and MCP via setImmediate)
- [src/db/schema.ts](../src/db/schema.ts) (drop `tasks.disabledSkills` AND `tasks.disabledMcpServers`; document `chat_messages.role = "tool"`)
- [src/db/config-backfill.ts](../src/db/config-backfill.ts) (YAML → JSON output)
- [src/__tests__/helpers.ts](../src/__tests__/helpers.ts) (drop both columns; accept `tool` role)
